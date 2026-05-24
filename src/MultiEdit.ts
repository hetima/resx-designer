import * as vscode from 'vscode';
import * as path from 'path';
import { TableEditProvider, ToolbarButton } from './table-edit';
import {
  ResxLocaleSet, ResxGridRow, ResxDocument, ResxEntry,
  MultiEditTempFileMetadata, TableEditRow
} from './types/resx';
import { findRelatedResxFiles, getSortedLocales, parseResxFilename } from './resx-locale-finder';
import { parseResx } from './resx-parser';
import { serializeResx } from './resx-writer';
import { getThemeCssVariables } from './theme-colors';
import { openBulkEditPanel } from './bulk-edit-panel';

// ─────────────────────────────────────────────────────────────────────
// MultiEditCustomDocument — document model for the custom editor
// ─────────────────────────────────────────────────────────────────────

export class MultiEditCustomDocument implements vscode.CustomDocument {

  readonly uri: vscode.Uri;
  readonly metadata: MultiEditTempFileMetadata;

  private _controller: MultiEditController | null = null;

  constructor(uri: vscode.Uri, metadata: MultiEditTempFileMetadata) {
    this.uri = uri;
    this.metadata = metadata;
  }

  get controller(): MultiEditController { return this._controller!; }
  setController(c: MultiEditController): void { this._controller = c; }

  dispose(): void {
    this.writeClosedFlag();
    this._controller?.dispose();
    this._controller = null;
  }

  private writeClosedFlag(): void {
    const data: MultiEditTempFileMetadata = { ...this.metadata, closed: true };
    vscode.workspace.fs.writeFile(
      this.uri,
      new TextEncoder().encode(JSON.stringify(data, null, 2))
    ).then(undefined, err => {
      console.warn('[multiEdit] failed to write closed flag', err);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// MultiEditController — manages one multi-edit webview + its state
// Extends TableEditProvider for the grid engine.
// ─────────────────────────────────────────────────────────────────────

class MultiEditController extends TableEditProvider {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly webviewPanel: vscode.WebviewPanel;
  private readonly metadata: MultiEditTempFileMetadata;
  private readonly context: vscode.ExtensionContext;
  private localeSet: ResxLocaleSet | null = null;
  /** Sorted locale keys (default first, rest alphabetical) */
  private sortedLocales: Array<string | null> = [];
  /** Merged grid rows (same structure as ResxEdit.gridRows) */
  private gridRows: ResxGridRow[] = [];

  /** Pending cell edits: rowName → fieldKey → value */
  private pendingEdits = new Map<string, Map<string, string>>();
  /** Pending new keys (added but not yet saved) */
  private pendingAdditions: Array<{ name: string; afterKey: string | null }> = [];
  /** Pending key deletions (deleted but not yet saved) */
  private pendingDeletes = new Set<string>();

  /** Snapshot of original rows for dirty detection */
  private originalRowNames: string[] = [];

  constructor(
    context: vscode.ExtensionContext,
    webviewPanel: vscode.WebviewPanel,
    metadata: MultiEditTempFileMetadata,
    private readonly fireDirty: () => void
  ) {
    super({ notifyCellEdits: true });
    this.context = context;
    this.webviewPanel = webviewPanel;
    this.metadata = metadata;
  }

  /** Initialize: load locale set and render webview. Call once after construction. */
  async init(): Promise<void> {
    // Normalize sourceUri to default file (strip locale suffix)
    const parsedUri = vscode.Uri.parse(this.metadata.sourceUri);
    const normalizedUri = MultiEditCustomEditorProvider.normalizeSourceUri(parsedUri);
    (this.metadata as any).sourceUri = normalizedUri.toString();

    try {
      this.localeSet = await findRelatedResxFiles(vscode.Uri.parse(this.metadata.sourceUri));
    } catch (err) {
      console.error('[multiEdit] failed to load locale set', err);
    }

    if (!this.localeSet) {
      vscode.window.showErrorMessage(
        `RESX Multi Edit: Could not find related locale files for "${this.metadata.sourceUri}".`
      );
      return;
    }

    // Overlay the default file's in-memory content
    this.overlayDefaultDocument();

    this.buildGrid();
    this.storeOriginalState();

    // Attach TableEditProvider base message handler
    this.attach(this.webviewPanel);

    // Additional message listener for multi-edit specific messages
    const sub = this.webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
      await this.handleMessage(msg);
    });
    this.disposables.push(sub);

    // Render
    this.rebuildWebview();
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
    this.disposables.length = 0;
  }

  // ── Data ─────────────────────────────────────────────────────────

  /** Overlay default document content from the source file. */
  private overlayDefaultDocument(): void {
    if (!this.localeSet) { return; }
    const defaultDoc = this.localeSet.locales.get(null);
    if (defaultDoc) {
      // Already loaded from disk, ok
    }
  }

  private buildGrid(): void {
    if (!this.localeSet) { return; }

    // Always use null for currentLocale — default-first, alphabetical rest
    this.sortedLocales = getSortedLocales(this.localeSet, null);

    // Merge all keys across locales
    const nameOrder: string[] = [];
    const nameSet = new Set<string>();

    for (const loc of this.sortedLocales) {
      const doc = this.localeSet!.locales.get(loc)!;
      for (const entry of doc.entries) {
        if (!nameSet.has(entry.name)) {
          nameSet.add(entry.name);
          nameOrder.push(entry.name);
        }
      }
    }

    this.gridRows = nameOrder.map(name => {
      const row: ResxGridRow = { name, comment: '', values: new Map(), definedIn: new Set() };
      for (const loc of this.sortedLocales) {
        const doc = this.localeSet!.locales.get(loc)!;
        const entry = doc.entries.find(e => e.name === name);
        if (entry) {
          row.values.set(loc, entry.value);
          row.definedIn.add(loc);
          if (entry.comment && (!row.comment || loc === null)) {
            row.comment = entry.comment;
          }
        }
      }
      return row;
    });
  }

  private storeOriginalState(): void {
    this.originalRowNames = this.gridRows.map(r => r.name);
  }

  // ── Build Table Data for TableEditProvider ─────────────────────

  private buildTableData(): { columns: any[]; rows: any[] } {
    if (!this.localeSet) { return { columns: [], rows: [] }; }

    // Columns: index, action, name, comment, then each locale
    const columns: any[] = [
      {
        kind: "index" as const,
        locale: null,
        label: "#",
        editable: false,
        resizable: false,
        width: "auto",
      },
      {
        kind: "action" as const,
        locale: null,
        label: "",
        editable: false,
        resizable: false,
        width: 24,
      },
      {
        kind: "checkbox" as const,
        locale: null,
        label: "",
        editable: false,
        resizable: false,
        width: 30,
      },
      {
        kind: "name" as const,
        locale: null,
        label: "Name",
        editable: true,
        resizable: true,
        width: 140,
      },
      {
        kind: "comment" as const,
        locale: null,
        label: "Comment",
        editable: true,
        resizable: true,
        width: 120,
      },
    ];
    for (const loc of this.sortedLocales) {
      columns.push({
        kind: 'locale' as const,
        locale: loc,
        label: loc ?? '(default)',
        editable: true,
        resizable: true,
        width: 180,
      });
    }

    // Rows — apply pending edits on top of gridRows
    const rows: any[] = [];
    for (const r of this.gridRows) {
      if (this.pendingDeletes.has(r.name)) { continue; }

      const pendingForRow = this.pendingEdits.get(r.name);
      const name = pendingForRow?.get('__name__') ?? r.name;
      const comment = pendingForRow?.get('__comment__') ?? r.comment;

      const values = Object.fromEntries(
        this.sortedLocales.map(loc => {
          const pendingVal = pendingForRow?.get(loc === null ? '__null__' : loc);
          return [loc, pendingVal ?? r.values.get(loc) ?? ''];
        })
      );

      rows.push({
        name, comment, values,
        menu: [
          { id: 'bulkEdit', label: 'Bulk Edit' },
          { id: 'insertBelow', label: 'Insert Below' },
          { id: 'separator' },
          { id: 'delete', label: 'Delete Key', danger: true },
        ],
        menuTitle: name,
      });
    }

    // Insert pending new keys at their correct positions
    for (const addition of this.pendingAdditions) {
      if (this.pendingDeletes.has(addition.name)) { continue; }
      const values = Object.fromEntries(
        this.sortedLocales.map(loc => [loc, ''])
      );
      const newRow = {
        name: addition.name, comment: '', values,
        menu: [
          { id: 'insertBelow', label: 'Insert Below' },
          { id: 'separator' },
          { id: 'delete', label: 'Delete Key', danger: true },
        ],
        menuTitle: addition.name,
      };
      if (addition.afterKey) {
        const idx = rows.findIndex(r => r.name === addition.afterKey);
        if (idx >= 0) { rows.splice(idx + 1, 0, newRow); continue; }
      }
      rows.push(newRow);
    }

    return { columns, rows };
  }

  // ── Rebuild webview HTML ─────────────────────────────────────────

  private rebuildWebview(): void {
    if (!this.webviewPanel) { return; }

    const { columns, rows } = this.buildTableData();
    const sourceUri = vscode.Uri.parse(this.metadata.sourceUri);
    const sourceName = vscode.workspace.asRelativePath(sourceUri, false);

    const toolbarButtons: ToolbarButton[] = [
      {
        id: 'addLang',
        icon: '+ New Lang',
        title: 'Add a new language column',
        align: 'left',
        onClick: () => {},
      },
      {
        id: 'addKey',
        icon: '+ New Key',
        title: 'Add a new resource key',
        align: 'left',
        onClick: () => {},
      },
      {
        id: 'deleteChecked',
        icon: '✕ Delete Checked',
        title: 'Delete all checked rows',
        align: 'left',
        onClick: () => {},
      },
    ];

    this.webviewPanel.webview.html = this.buildHtml(
      columns,
      rows,
      { title: '[Multi] ' + sourceName, additionalScript: this.getDialogScript() },
      toolbarButtons
    );

    // Restore scroll position and selected cell after webview re-initializes
    setTimeout(() => {
      this.webviewPanel?.webview.postMessage({ type: 'restoreViewState' });
    }, 50);
  }

  // ── Message Handling ─────────────────────────────────────────────

  private async handleMessage(msg: any): Promise<void> {
    if (msg.type === 'tableEditDirty' && msg.isDirty) {
      this.fireDirty();
    }
    if (msg.type === 'copyToClipboard') {
      await vscode.env.clipboard.writeText(msg.text);
    }
    if (msg.type === 'addKey') {
      this.handleAddKey(msg.name, msg.insertAfterIndex);
    }
    if (msg.type === 'addLocale') {
      this.handleAddLocale(msg.locale, msg.fillDefaults);
    }
    if (msg.type === 'deleteKey') {
      this.handleDeleteKey(msg.name);
    }
    if (msg.type === 'actionMenu') {
      this.handleActionMenu(msg.actionId, msg.rowIdx);
    }
    if (msg.type === 'deleteChecked') {
      this.handleDeleteChecked(msg.rowNames);
    }
  }

  private async handleAddKey(name: string, insertAfterIndex?: number): Promise<void> {
    if (!name) { return; }
    // Check duplicates in gridRows + pendingAdditions
    const existingNames = new Set([
      ...this.gridRows.map(r => this.pendingEdits.get(r.name)?.get('__name__') ?? r.name),
      ...this.pendingAdditions.map(a => a.name),
    ]);
    if (existingNames.has(name)) {
      vscode.window.showWarningMessage(`RESX: Key "${name}" already exists.`);
      return;
    }

    // Resolve afterKey from insertAfterIndex
    let afterKey: string | null = null;
    if (insertAfterIndex != null && insertAfterIndex >= 0) {
      const { rows } = this.buildTableData();
      if (insertAfterIndex < rows.length) {
        afterKey = rows[insertAfterIndex].name;
      }
    }

    this.pendingAdditions.push({ name, afterKey });
    await this.save();
  }

  private async handleDeleteKey(name: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Delete key "${name}"?`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') { return; }

    const addIdx = this.pendingAdditions.findIndex(a => a.name === name);
    if (addIdx >= 0) {
      this.pendingAdditions.splice(addIdx, 1);
      this.pendingEdits.delete(name);
      this.rebuildWebview();
    } else {
      this.pendingDeletes.add(name);
      await this.save();
    }
  }

  private async handleActionMenu(actionId: string, rowIdx: number): Promise<void> {
    const { rows } = this.buildTableData();
    if (rowIdx < 0 || rowIdx >= rows.length) { return; }
    const rowName = rows[rowIdx]?.name;
    if (!rowName) { return; }

    switch (actionId) {
      case 'bulkEdit':
        await openBulkEditPanel(this.context, vscode.Uri.parse(this.metadata.sourceUri), rowName);
        break;
      case 'delete':
        await this.handleDeleteKey(rowName);
        break;
      case 'insertBelow':
        this.webviewPanel?.webview.postMessage({ type: '_openInsertKeyDialog', rowIdx });
        break;
    }
  }

  private async handleDeleteChecked(rowNames: string[]): Promise<void> {
    if (!rowNames || rowNames.length === 0) { return; }

    const count = rowNames.length;
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${count} checked key${count > 1 ? 's' : ''}?\n\nUnsaved edits will be saved first.`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') { return; }

    // Save current edits first (prevent edit loss)
    await this.save();

    // Mark checked rows for deletion, then save again
    for (const name of rowNames) {
      this.pendingDeletes.add(name);
    }
    await this.save();
  }

  // ── Add Locale ───────────────────────────────────────────────

  private async handleAddLocale(locale: string, fillDefaults: boolean): Promise<void> {
    if (!this.localeSet || !this.webviewPanel) { return; }

    if (this.localeSet.locales.has(locale)) {
      this.webviewPanel.webview.postMessage({
        type: 'addLocaleResult', success: false, locale,
        message: `Locale "${locale}" already exists.`,
      });
      return;
    }

    const fileName = this.localeSet.baseName.replace('.resx', `.${locale}.resx`);
    const filePath = path.join(this.localeSet.baseDir, fileName);
    const defaultDoc = this.localeSet.locales.get(null);
    const doc: ResxDocument = {
      path: filePath,
      locale,
      entries: this.gridRows.map(r => ({
        name: r.name,
        value: fillDefaults ? (r.values.get(null) ?? '') : '',
        comment: r.comment,
      })),
    };

    const xml = serializeResx(doc);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      new TextEncoder().encode(xml)
    );

    this.webviewPanel.webview.postMessage({
      type: 'addLocaleResult', success: true, locale,
      message: `Language "${locale}" added successfully.`,
    });

    await this.reloadLocaleSet();
    this.buildGrid();
    this.storeOriginalState();
    this.rebuildWebview();

    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
  }

  // ── Sync pending edits from webview ──────────────────────────────

  private async syncPendingEditsFromWebview(): Promise<void> {
    const changes = await this.getChanges();
    const { rows, columns } = this.buildTableData();

    for (const c of changes) {
      if (c.kind !== 'cell') { continue; }
      if (c.row < 0 || c.row >= rows.length) { continue; }

      const rowName = rows[c.row].name;
      
      // Determine the field key from the change object
      let fieldKey: string;
      
      if ((c as any).field === 'name') {
        fieldKey = '__name__';
      } else if ((c as any).field === 'comment') {
        fieldKey = '__comment__';
      } else if ((c as any).locale !== undefined) {
        // Locale column edit
        const locale = (c as any).locale;
        fieldKey = locale === 'null' ? '__null__' : locale;
      } else {
        continue;
      }

      if (!this.pendingEdits.has(rowName)) {
        this.pendingEdits.set(rowName, new Map());
      }
      this.pendingEdits.get(rowName)!.set(fieldKey, (c as any).newValue);
    }
  }

  // ── Save / Revert ────────────────────────────────────────────────

  get hasPendingEdits(): boolean {
    return this.pendingEdits.size > 0 || this.pendingAdditions.length > 0 || this.pendingDeletes.size > 0;
  }

  async save(): Promise<void> {
    if (!this.localeSet) { return; }

    // Sync pending edits from webview
    await this.syncPendingEditsFromWebview();

    // 1. Handle key deletions
    for (const name of this.pendingDeletes) {
      for (const [, doc] of this.localeSet.locales) {
        doc.entries = doc.entries.filter(e => e.name !== name);
      }
    }

    // 2. Handle new keys (with insertAfterIndex support)
    for (const addition of this.pendingAdditions) {
      const name = addition.name;
      const addEntry = (doc: ResxDocument): void => {
        const entry: ResxEntry = { name, value: '', comment: '' };
        if (addition.afterKey) {
          const idx = doc.entries.findIndex(e => e.name === addition.afterKey);
          if (idx >= 0) { doc.entries.splice(idx + 1, 0, entry); }
          else { doc.entries.push(entry); }
        } else {
          doc.entries.push(entry);
        }
      };
      for (const [, doc] of this.localeSet.locales) {
        addEntry(doc);
        const pendingForRow = this.pendingEdits.get(name);
        const value = pendingForRow?.get('__null__') ?? pendingForRow?.get(null as any) ?? '';
        const comment = pendingForRow?.get('__comment__') ?? '';
        const entry = doc.entries.find(e => e.name === name);
        if (entry) { entry.value = value; entry.comment = comment; }
      }
    }

    // 3. Handle cell edits for existing rows
    for (const [rowName, changes] of this.pendingEdits) {
      if (this.pendingDeletes.has(rowName)) { continue; }
      if (this.pendingAdditions.some(a => a.name === rowName)) { continue; } // Already handled above

      // First pass: update name and comment
      const newName = changes.get('__name__');
      const newComment = changes.get('__comment__');
      
      if (newName !== undefined) {
        // Rename across all locales
        for (const [, doc] of this.localeSet.locales) {
          const entry = doc.entries.find(e => e.name === rowName);
          if (entry) { entry.name = newName; }
        }
      }
      
      if (newComment !== undefined) {
        // Update comment - only in default locale if it exists there, otherwise all locales
        const defaultDoc = this.localeSet.locales.get(null);
        if (defaultDoc) {
          const defaultEntry = defaultDoc.entries.find(e => e.name === (newName ?? rowName));
          if (defaultEntry) {
            defaultEntry.comment = newComment;
          }
        }
        // Also update in other locales if they have this entry
        for (const [locale, doc] of this.localeSet.locales) {
          if (locale === null) { continue; } // Already handled above
          const entry = doc.entries.find(e => e.name === (newName ?? rowName));
          if (entry) { entry.comment = newComment; }
        }
      }

      // Second pass: update locale values
      for (const [fieldKey, newValue] of changes) {
        if (fieldKey === '__name__' || fieldKey === '__comment__') { continue; } // Already handled
        
        // Locale value update
        const locale = fieldKey === '__null__' ? null : fieldKey;
        const doc = this.localeSet.locales.get(locale);
        if (doc) {
          const entry = doc.entries.find(e => e.name === (newName ?? rowName));
          if (entry) {
            entry.value = newValue;
          } else {
            // Create new entry if it doesn't exist
            const comment = newComment ?? '';
            doc.entries.push({ name: (newName ?? rowName), value: newValue, comment });
          }
        }
      }
    }

    // 4. Write all locale files
    for (const [, doc] of this.localeSet.locales) {
      const xml = serializeResx(doc);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(doc.path),
        new TextEncoder().encode(xml)
      );
    }

    // 5. Reset state
    this.pendingEdits.clear();
    this.pendingAdditions = [];
    this.pendingDeletes.clear();

    // Reload locale set from disk
    await this.reloadLocaleSet();
    this.buildGrid();
    this.storeOriginalState();
    this.rebuildWebview();
    this.resetDirty();

    vscode.window.showInformationMessage(
      `RESX: Multi Edit saved to all locale files.`
    );
  }

  async revert(): Promise<void> {
    this.pendingEdits.clear();
    this.pendingAdditions = [];
    this.pendingDeletes.clear();
    await this.reloadLocaleSet();
    this.buildGrid();
    this.storeOriginalState();
    this.rebuildWebview();
    this.resetDirty();
  }

  private async reloadLocaleSet(): Promise<void> {
    try {
      this.localeSet = await findRelatedResxFiles(vscode.Uri.parse(this.metadata.sourceUri));
    } catch (err) {
      console.error('[multiEdit] failed to reload locale set', err);
    }
  }

  // ── Get pending edits for backup ─────────────────────────────

  getPendingEditsForBackup(): Record<string, Record<string, string>> {
    const obj: Record<string, Record<string, string>> = {};
    for (const [rowName, changes] of this.pendingEdits) {
      obj[rowName] = Object.fromEntries(changes);
    }
    return obj;
  }

  restorePendingEdits(data: Record<string, Record<string, string>>): void {
    this.pendingEdits.clear();
    for (const [rowName, changes] of Object.entries(data)) {
      this.pendingEdits.set(rowName, new Map(Object.entries(changes)));
    }
  }

  // ── Dialog Script (inline JS for webview) ──────────────────────

  private getDialogScript(): string {
    return `
    // ── Toolbar action dispatcher ────────────────────────────
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'addKeyResult') _handleAddKeyResult(msg);
      if (msg.type === 'addLocaleResult') _handleAddLocaleResult(msg);
    });

    function _handleToolbarAction(id) {
      switch (id) {
        case 'addLang': _openAddLangDialog(); break;
        case 'addKey': _openAddKeyDialog(); break;
        case 'deleteChecked':
          const names = rows.filter(r => checkedRows.has(r.name)).map(r => r.name);
          if (names.length > 0) _notifyHost('deleteChecked', { rowNames: names });
          break;
      }
    }

    // Expose checked count updater to base script
    window._setCheckedCount = (count) => {
      const btn = document.querySelector('.toolbar-btn[data-action="deleteChecked"]');
      if (btn) btn.disabled = count === 0;
    };
    window._setCheckedCount(0);

    // Override handleToolbarAction from base
    document.getElementById('toolbar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.toolbar-btn');
      if (!btn) return;
      const id = btn.dataset.action;
      if (id && id !== '__search') _handleToolbarAction(id);
    }, true);

    // ── Add Language dialog ─────────────────────────────────
    const KNOWN_LOCALES = ['af','am','ar','as','az','be','bg','bn','bs','ca','cs','cy','da','de','dv','el','en','en-AU','en-CA','en-GB','en-IN','en-US','en-ZA','eo','es','es-ES','es-MX','et','eu','fa','fi','fo','fr','fr-CA','fr-FR','ga','gd','gl','gu','he','hi','hr','hu','hy','id','ig','is','it','ja','ka','kk','km','kn','ko','ku','ky','lb','lo','lt','lv','mk','ml','mn','mr','ms','mt','nb','ne','nl','nn','no','or','pa','pl','ps','pt','pt-BR','pt-PT','qu','ro','ru','rw','sd','si','sk','sl','so','sq','sr','sv','sw','ta','te','th','ti','tk','tl','tn','tr','tt','ug','uk','ur','uz','vi','wo','xh','yi','yo','zh','zh-CN','zh-Hans','zh-Hant','zh-HK','zh-TW','zu'];

    function _openAddLangDialog() {
      let el = document.getElementById('_addLangOverlay');
      if (el) el.remove();
      el = document.createElement('div');
      el.id = '_addLangOverlay';
      el.className = 'dialog-overlay';
      el.innerHTML = '<div class="dialog-box"><div class="dialog-title">Add Language</div><div class="dialog-field"><input id="_addLangInput" class="dialog-input" type="text" placeholder="Locale code (e.g. ja, en-US, fr)" spellcheck="false" list="_addLangSuggestions" autocomplete="off"><datalist id="_addLangSuggestions"></datalist></div><div id="_addLangWarning" class="dialog-message"></div><label class="dialog-checkbox-label"><input id="_addLangFillDefaults" type="checkbox" checked> Copy default values</label><div id="_addLangMessage" class="dialog-message"></div><div class="dialog-buttons"><button id="_addLangCancel" class="dialog-btn">Cancel</button><button id="_addLangOk" class="dialog-btn">OK</button></div></div>';
      document.body.appendChild(el);
      const dl = document.getElementById('_addLangSuggestions');
      KNOWN_LOCALES.forEach(loc => { const o = document.createElement('option'); o.value = loc; dl.appendChild(o); });
      const input = document.getElementById('_addLangInput');
      const warnEl = document.getElementById('_addLangWarning');
      const msgEl = document.getElementById('_addLangMessage');
      const okBtn = document.getElementById('_addLangOk');
      msgEl.textContent = '';
      input.focus();
      input.addEventListener('input', () => {
        const v = input.value.trim();
        if (!v || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]+)*$/.test(v)) { warnEl.textContent = ''; return; }
        warnEl.textContent = KNOWN_LOCALES.includes(v) ? '' : '\u26A0 Unknown locale code';
      });
      const close = () => { el.remove(); };
      document.getElementById('_addLangCancel').addEventListener('click', close);
      el.addEventListener('click', (e) => { if (e.target === el) close(); });
      okBtn.addEventListener('click', () => {
        const locale = input.value.trim();
        if (!locale || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]+)*$/.test(locale)) { msgEl.textContent = 'Valid locale code required.'; msgEl.className = 'dialog-message error'; return; }
        _notifyHost('addLocale', { locale, fillDefaults: document.getElementById('_addLangFillDefaults').checked });
        okBtn.disabled = true;
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') okBtn.click(); if (e.key === 'Escape') close(); });
    }

    function _handleAddLocaleResult(msg) {
      const msgEl = document.getElementById('_addLangMessage');
      const okBtn = document.getElementById('_addLangOk');
      if (!msgEl) return;
      if (msg.success) {
        msgEl.textContent = msg.message;
        msgEl.className = 'dialog-message success';
        const overlay = document.getElementById('_addLangOverlay');
        setTimeout(() => { if (overlay) overlay.remove(); }, 800);
      } else {
        msgEl.textContent = msg.message;
        msgEl.className = 'dialog-message error';
        if (okBtn) okBtn.disabled = false;
      }
    }

    // ── Add Key dialog ──────────────────────────────────────
    window.__insertAfterIndex = undefined;

    function _openAddKeyDialog(insertAfterIndex) {
      let el = document.getElementById('_addKeyOverlay');
      if (el) el.remove();
      el = document.createElement('div');
      el.id = '_addKeyOverlay';
      el.className = 'dialog-overlay';
      el.innerHTML = '<div class="dialog-box"><div class="dialog-title">Add New Key</div><div class="dialog-field"><input id="_addKeyInput" class="dialog-input" type="text" placeholder="Resource key name" spellcheck="false" autocomplete="off"></div><div id="_addKeyMessage" class="dialog-message"></div><div class="dialog-buttons"><button id="_addKeyCancel" class="dialog-btn">Cancel</button><button id="_addKeyOk" class="dialog-btn">OK</button></div></div>';
      document.body.appendChild(el);
      const input = document.getElementById('_addKeyInput');
      const msgEl = document.getElementById('_addKeyMessage');
      const okBtn = document.getElementById('_addKeyOk');
      msgEl.textContent = '';
      window.__insertAfterIndex = insertAfterIndex;
      input.focus();
      const close = () => { el.remove(); };
      document.getElementById('_addKeyCancel').addEventListener('click', close);
      el.addEventListener('click', (e) => { if (e.target === el) close(); });
      okBtn.addEventListener('click', () => {
        const name = input.value.trim();
        if (!name) { msgEl.textContent = 'Key name is required.'; msgEl.className = 'dialog-message error'; return; }
        _notifyHost('addKey', { name, insertAfterIndex: window.__insertAfterIndex });
        okBtn.disabled = true;
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') okBtn.click(); if (e.key === 'Escape') close(); });
    }

    function _handleAddKeyResult(msg) {
      const msgEl = document.getElementById('_addKeyMessage');
      const okBtn = document.getElementById('_addKeyOk');
      if (!msgEl) return;
      if (msg.success) {
        msgEl.textContent = msg.message;
        msgEl.className = 'dialog-message success';
        const overlay = document.getElementById('_addKeyOverlay');
        setTimeout(() => { if (overlay) overlay.remove(); }, 800);
      } else {
        msgEl.textContent = msg.message;
        msgEl.className = 'dialog-message error';
        if (okBtn) okBtn.disabled = false;
      }
    }

    // ── Action menu (dialogs triggered by host) ────────────────
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === '_openInsertKeyDialog') {
        _openAddKeyDialog(msg.rowIdx);
      }
    });

    // ── Dialog CSS ──────────────────────────────────────────
    const _dialogStyle = document.createElement('style');
    _dialogStyle.textContent = \`
      .dialog-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh; background: rgba(0,0,0,0.5); backdrop-filter: blur(2px); }
      .dialog-box { background: var(--resx-body); border: 1px solid var(--resx-border); border-radius: 6px; padding: 14px 18px 18px; width: 300px; box-shadow: 0 4px 16px rgba(0,0,0,0.25); color: var(--resx-fg); font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); font-size: 14px; }
      .dialog-title { font-size: 15px; font-weight: 600; margin-bottom: 10px; }
      .dialog-field { margin-bottom: 8px; }
      .dialog-input { width: 100%; box-sizing: border-box; height: 30px; padding: 0 8px; border: 1px solid var(--resx-input-border, var(--resx-border)); border-radius: 2px; background: var(--resx-input-bg, var(--vscode-input-background)); color: var(--resx-input-fg, var(--resx-fg)); font-size: 14px; font-family: inherit; outline: none; }
      .dialog-input:focus { border-color: var(--resx-focus-border, var(--vscode-focusBorder)); box-shadow: 0 0 0 1px var(--resx-focus-border, var(--resx-focusBorder)); }
      .dialog-message { font-size: 13px; min-height: 16px; margin-bottom: 6px; line-height: 1.4; }
      .dialog-message.error { color: var(--vscode-notificationsErrorIcon-foreground, #f44); }
      .dialog-message.success { color: var(--vscode-notificationsInfoIcon-foreground, #3794ff); }
      .dialog-buttons { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
      .dialog-btn { padding: 5px 14px; border: none; border-radius: 2px; background: var(--resx-btn-bg, var(--vscode-button-background)); color: var(--resx-btn-fg, var(--vscode-button-foreground)); font-size: 13px; font-family: inherit; cursor: pointer; }
      .dialog-btn:hover { background: var(--resx-btn-hover, var(--vscode-button-hoverBackground)); }
      .dialog-checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; margin-bottom: 6px; cursor: pointer; }
    \`;
    document.head.appendChild(_dialogStyle);
    `;
  }
}

// ─────────────────────────────────────────────────────────────────────
// MultiEditCustomEditorProvider — CustomEditorProvider implementation
// ─────────────────────────────────────────────────────────────────────

export class MultiEditCustomEditorProvider implements vscode.CustomEditorProvider<MultiEditCustomDocument> {

  public static readonly viewType = 'resx.multiEdit';

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<MultiEditCustomDocument>
  >();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  private readonly extensionContext: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.extensionContext = context;
  }

  // ── CustomEditorProvider lifecycle ───────────────────────────────

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<MultiEditCustomDocument> {
    let metadata: MultiEditTempFileMetadata;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      metadata = JSON.parse(new TextDecoder().decode(bytes)) as MultiEditTempFileMetadata;
    } catch {
      throw new Error(`RESX Multi Edit: Cannot read temp file "${uri.fsPath}".`);
    }
    if (!metadata.sourceUri) {
      throw new Error(`RESX Multi Edit: Invalid metadata in "${uri.fsPath}".`);
    }

    const document = new MultiEditCustomDocument(uri, metadata);

    // Restore pending edits from backup (hot-exit)
    if (openContext.backupId) {
      try {
        const backupBytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId));
        const backupData = JSON.parse(new TextDecoder().decode(backupBytes)) as {
          metadata?: MultiEditTempFileMetadata;
          pendingEdits?: Record<string, Record<string, string>>;
        };
        // Will be applied in resolveCustomEditor after controller init
        (document as any).__backupPendingEdits = backupData.pendingEdits ?? {};
      } catch {
        // backup read failed — ignore, start fresh
      }
    }

    return document;
  }

  async resolveCustomEditor(
    document: MultiEditCustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.extensionContext.extensionPath, 'media'))
      ],
    };

    const controller = new MultiEditController(
      this.extensionContext,
      webviewPanel,
      document.metadata,
      () => this._onDidChangeCustomDocument.fire({ document })
    );
    document.setController(controller);

    // Restore backup pending edits if available
    const backupEdits = (document as any).__backupPendingEdits;
    if (backupEdits) {
      delete (document as any).__backupPendingEdits;
      // Will be applied after init
    }

    await controller.init();

    if (backupEdits && Object.keys(backupEdits).length > 0) {
      controller.restorePendingEdits(backupEdits);
      // Rebuild to show restored state
    }
  }

  // ── Save / Revert / Backup ───────────────────────────────────────

  async saveCustomDocument(
    document: MultiEditCustomDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await document.controller.save();
  }

  async saveCustomDocumentAs(
    document: MultiEditCustomDocument,
    _destination: vscode.Uri,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await document.controller.save();
  }

  async revertCustomDocument(
    document: MultiEditCustomDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await document.controller.revert();
  }

  async backupCustomDocument(
    document: MultiEditCustomDocument,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    const backupData = {
      metadata: document.metadata,
      pendingEdits: document.controller.getPendingEditsForBackup(),
    };
    await vscode.workspace.fs.writeFile(
      context.destination,
      new TextEncoder().encode(JSON.stringify(backupData))
    );
    return {
      id: context.destination.toString(),
      delete: () => { vscode.workspace.fs.delete(context.destination); }
    };
  }

  // ── Temp File Utilities (static, for use by commands) ─────────────

  public static async ensureTempDir(context: vscode.ExtensionContext): Promise<vscode.Uri> {
    const dir = vscode.Uri.file(path.join(context.globalStorageUri.fsPath, 'multi-edit'));
    try { await vscode.workspace.fs.createDirectory(dir); } catch { /* already exists */ }
    return dir;
  }

  /** Normalize a source URI to its default locale file (strip locale suffix). */
  public static normalizeSourceUri(sourceUri: vscode.Uri): vscode.Uri {
    const { baseName } = parseResxFilename(path.basename(sourceUri.fsPath));
    const defaultPath = path.join(path.dirname(sourceUri.fsPath), baseName);
    return vscode.Uri.file(defaultPath);
  }

  public static async createTempFile(
    context: vscode.ExtensionContext,
    sourceUri: vscode.Uri
  ): Promise<vscode.Uri> {
    const dir = await MultiEditCustomEditorProvider.ensureTempDir(context);

    // Normalize to default file before storing
    const defaultUri = MultiEditCustomEditorProvider.normalizeSourceUri(sourceUri);

    // Derive baseName from the normalized default file
    const baseName = path.basename(defaultUri.fsPath);
    const fileName = `[Multi] ${baseName}.resxmulti`;
    const tmpUri = vscode.Uri.file(path.join(dir.fsPath, fileName));
    const metadata: MultiEditTempFileMetadata = {
      sourceUri: defaultUri.toString(),
    };

    // If existing temp file has closed flag, it's safe to reuse (just overwrite)
    try {
      const existingBytes = await vscode.workspace.fs.readFile(tmpUri);
      const existingMeta = JSON.parse(new TextDecoder().decode(existingBytes)) as MultiEditTempFileMetadata;
      if (existingMeta.closed) {
        await vscode.workspace.fs.writeFile(
          tmpUri,
          new TextEncoder().encode(JSON.stringify(metadata, null, 2))
        );
        return tmpUri;
      }
    } catch { /* not found or corrupt — fall through to fresh create */ }

    // Delete existing if present (unclosed crash remnant)
    try { await vscode.workspace.fs.delete(tmpUri); } catch { /* not found */ }
    await vscode.workspace.fs.writeFile(
      tmpUri,
      new TextEncoder().encode(JSON.stringify(metadata, null, 2))
    );
    return tmpUri;
  }

  /** Scan all .resxmulti temp files. */
  public static async scanAllTempFiles(
    context: vscode.ExtensionContext
  ): Promise<Array<{ uri: vscode.Uri; metadata: MultiEditTempFileMetadata }>> {
    const dir = await MultiEditCustomEditorProvider.ensureTempDir(context);
    const results: Array<{ uri: vscode.Uri; metadata: MultiEditTempFileMetadata }> = [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.resxmulti')) { continue; }
        const uri = vscode.Uri.file(path.join(dir.fsPath, name));
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const text = new TextDecoder().decode(bytes);
          const metadata = JSON.parse(text) as MultiEditTempFileMetadata;
          if (metadata.sourceUri) {
            results.push({ uri, metadata });
          }
        } catch {
          // corrupt file, skip
        }
      }
    } catch {
      // directory read failed
    }
    return results;
  }

  public static async deleteOrphanedFiles(
    context: vscode.ExtensionContext,
    uris: vscode.Uri[]
  ): Promise<void> {
    for (const uri of uris) {
      try { await vscode.workspace.fs.delete(uri); } catch { /* ignore */ }
    }
  }
}
