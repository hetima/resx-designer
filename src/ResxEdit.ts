import * as vscode from 'vscode';
import * as path from 'path';
import { TableEditProvider, ToolbarButton } from './table-edit';
import {
  ResxLocaleSet, ResxGridColumn, ResxGridRow,
  ResxDocument, ResxEntry,
} from './types/resx';
import { parseResx } from './resx-parser';
import { serializeResx } from './resx-writer';
import { findRelatedResxFiles, getSortedLocales, parseResxFilename } from './resx-locale-finder';
import { openBulkEditPanel } from './bulk-edit-panel';
import { openMultiEditPanel } from './multi-edit-panel';
import { getThemeCssVariables } from './theme-colors';

// ─────────────────────────────────────────────────────────────────────
// ResxEditController  Eone webview panel for one .resx file.
// Extends TableEditProvider for the grid engine.
// ─────────────────────────────────────────────────────────────────────

export class ResxEditController extends TableEditProvider {
  private _webviewPanel?: vscode.WebviewPanel;
  private document!: vscode.TextDocument;
  private localeSet: ResxLocaleSet | null | undefined;
  private columns: ResxGridColumn[] = [];
  private gridRows: ResxGridRow[] = [];
  private isUpdating = 0;  // counter: >0 means a write is in progress
  private lastWrittenUris = new Set<string>();
  private fileWatchers: vscode.FileSystemWatcher[] = [];
  private highlightMissing = true;
  private currentLocale: string | null = null;
  private _contextCell: { row: number; col: number; isHeader: boolean; selectedRows: number[]; name: string } | null = null;
  private readonly context: vscode.ExtensionContext;
  private colorThemeSub: vscode.Disposable | undefined;

  constructor(context: vscode.ExtensionContext) {
    super({ notifyCellEdits: true });
    this.context = context;
  }

  public getContextCell() { return this._contextCell; }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.document = document;
    this.currentLocale = parseResxFilename(path.basename(document.uri.fsPath)).locale ?? null;
    this._webviewPanel = webviewPanel;
    ResxEditProvider.controllers.push(this);

    // Detect diff/compare view or untitled scheme  Efall back to default text editor
    if (webviewPanel.viewColumn === undefined) {
      await this.openWithDefaultEditorAndClose(webviewPanel);
      return;
    }

    const config = vscode.workspace.getConfiguration('resx', this.document.uri);
    if (!config.get<boolean>('enabled', true)) {
      await this.openWithDefaultEditorAndClose(webviewPanel);
      return;
    }

    this.highlightMissing = config.get<boolean>('highlightMissingTranslations', true);

    // Always start in single mode (multi is now a separate editor tab).

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };

    // Load locale set
    await this.loadLocaleSet();

    // Render
    this.rebuildWebviewContent();

    // Listen for external file changes to related locale files
    this.setupFileWatchers();

    if (webviewPanel.active) {
      ResxEditProvider.currentActive = this;
    }

    // Attach TableEditProvider base message handler
    this.attach(webviewPanel);

    // Additional message listener
    const sub = webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
      await this.handleWebviewMessage(msg);
    });
    this._disposables.push(sub);

    // Watch for changes to the current document made outside our editor
    const changeSub = vscode.workspace.onDidChangeTextDocument(ev => {
      if (
        ev.document.uri.toString() === document.uri.toString() &&
        this.isUpdating === 0 &&
        !this.lastWrittenUris.has(ev.document.uri.toString())
      ) {
        setTimeout(() => this.reloadAndRefresh(), 300);
      }
    });

    // Guard against save-triggered reloads (Ctrl+S after our own applyEdit)
    const saveSub = vscode.workspace.onDidSaveTextDocument(savedDoc => {
      if (savedDoc.uri.toString() === document.uri.toString()) {
        this.lastWrittenUris.add(savedDoc.uri.toString());
        setTimeout(() => { this.lastWrittenUris.delete(savedDoc.uri.toString()); }, 2000);
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      saveSub.dispose();
      this.colorThemeSub?.dispose();
      for (const w of this.fileWatchers) { w.dispose(); }
      this.fileWatchers = [];
      ResxEditProvider.controllers = ResxEditProvider.controllers.filter(c => c !== this);
      this._webviewPanel = undefined;
      this.dispose();
    });

    webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        ResxEditProvider.currentActive = this;
      }
    });

    // Update CSS variables when the color theme changes
    this.colorThemeSub = vscode.window.onDidChangeActiveColorTheme(() => {
      this.updateThemeVariables();
    });
  }

  // ── Locale Set Loading ──────────────────────────────────────────

  private async loadLocaleSet(): Promise<void> {
    try {
      this.localeSet = await findRelatedResxFiles(this.document.uri);
    } catch (err) {
      console.error('RESX: failed to load locale set', err);
      this.localeSet = undefined;
    }

    if (this.localeSet) {
      // Always overlay the current document's in-memory content (which may be dirty)
      // over the disk-read version so hot-exit / unsaved edits are reflected.
      const xmlText = this.document.getText();
      const filePath = this.document.uri.fsPath;
      const { locale } = parseResxFilename(path.basename(filePath));
      const doc = parseResx(xmlText, filePath);
      doc.locale = locale;
      this.localeSet.locales.set(locale, doc);
      this.buildGrid();
    } else {
      // Fallback: read just the current file
      const xmlText = this.document.getText();
      const filePath = this.document.uri.fsPath;
      const { locale } = parseResxFilename(path.basename(filePath));
      const doc = parseResx(xmlText, filePath);
      doc.locale = locale;
      this.localeSet = {
        baseDir: path.dirname(filePath),
        baseName: path.basename(filePath),
        locales: new Map([[locale, doc]]),
      };
      this.buildGrid();
    }
  }

  private buildGrid(): void {
    if (!this.localeSet) { return; }

    const config = vscode.workspace.getConfiguration('resx', this.document.uri);
    const showSerialIndex = config.get<boolean>('showSerialIndex', false);
    const currentLocale = parseResxFilename(path.basename(this.document.uri.fsPath)).locale ?? null;
    const sortedLocales = getSortedLocales(this.localeSet, currentLocale);

    // Build columns: [index], action, name, comment, then each locale
    this.columns = [];
    if (showSerialIndex) {
      this.columns.push({ kind: 'index', locale: null, label: '#' });
    }
    this.columns.push({ kind: 'action', locale: null, label: '' });
    this.columns.push({ kind: 'name', locale: null, label: 'Name' });
    this.columns.push({ kind: 'comment', locale: null, label: 'Comment' });
    for (const loc of sortedLocales) {
      this.columns.push({
        kind: 'locale',
        locale: loc,
        label: loc ?? '(default)',
      });
    }

    // Build the merged grid of rows.
    const nameOrder: string[] = [];
    const nameSet = new Set<string>();

    for (const loc of sortedLocales) {
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
      for (const loc of sortedLocales) {
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

  /** Build columns/rows in TableEditProvider format from gridRows. */
  private buildTableData(): { columns: any[]; rows: any[] } {
    const visibleColumns = this.getVisibleColumns();

    const isDefaultFile = this.currentLocale === null;
    const lockNameAndDefault = !isDefaultFile;

    const columns = visibleColumns.map((vc) => {
      const col = { ...vc };
      if (col.kind === "index") {
        return { ...col, editable: false, resizable: false, width: "auto" };
      } else if (col.kind === "action") {
        return { ...col, editable: false, resizable: false, width: 24 };
      } else if (col.kind === "name") {
        return {
          ...col,
          editable: true,
          resizable: true,
          width: 180,
        };
      } else if (col.kind === "comment") {
        return { ...col, editable: true, resizable: true, width: 180 };
      } else if (col.kind === "locale") {
        const locked = lockNameAndDefault && col.locale === null;
        return { ...col, editable: !locked, resizable: true, width: 220 };
      }
      return col;
    });

    const rows = this.gridRows.map((r) => ({
      name: r.name,
      comment: r.comment,
      values: Object.fromEntries(
        visibleColumns
          .filter((c) => c.kind === "locale")
          .map((c) => [c.locale, r.values.get(c.locale) ?? ""]),
      ),
      menu: [
        { id: "bulkEdit", label: "Bulk Edit" },
        { id: "insertBelow", label: "Insert Below" },
        { id: "separator" },
        { id: "delete", label: "Delete", danger: true },
      ],
      menuTitle: r.name,
    }));

    return { columns, rows };
  }

  private getVisibleColumns(): Array<ResxGridColumn & { physicalIndex: number }> {
    const currentLocale = parseResxFilename(path.basename(this.document.uri.fsPath)).locale ?? null;

    // Single mode: always-visible columns, then default + current locale
    const visible: Array<ResxGridColumn & { physicalIndex: number }> = [];
    for (let i = 0; i < this.columns.length; i++) {
      const c = this.columns[i];
      if (c.kind === 'index' || c.kind === 'action' || c.kind === 'name' || c.kind === 'comment') {
        visible.push({ ...c, physicalIndex: i });
      } else if (c.kind === 'locale') {
        if (c.locale === null) {
          visible.push({ ...c, physicalIndex: i });
        } else if (c.locale === currentLocale) {
          visible.push({ ...c, physicalIndex: i });
        }
      }
    }
    return visible;
  }

  // ── Webview Content ───────────────────────────────────────────

  private rebuildWebviewContent(): void {
    if (!this._webviewPanel || !this.localeSet) { return; }

    const { columns, rows } = this.buildTableData();

    const toolbarButtons: Array<
      | ToolbarButton
      | { id: string; icon: string; title?: string; align?: "left" | "right" }
    > = [
      {
        id: "addLang",
        icon: "+ New Lang",
        title: "Add a new language column",
        align: "left",
      },
      {
        id: "addKey",
        icon: "+ New Key",
        title: "Add a new resource key",
        align: "left",
      },
      {
        id: "sortAZ",
        icon: "Sort A-Z",
        title: "Sort names alphabetically",
        align: "right",
      },
      {
        id: "viewMode",
        icon: "Multi Edit",
        title: "Show all locale columns",
        align: "right",
      },
      {
        id: "openAsText",
        icon: "Open as Text",
        title: "Open this file in the default text editor",
        align: "right",
      },
    ];

    const sourceName = vscode.workspace.asRelativePath(this.document.uri, false);
    this._webviewPanel.webview.html = this.buildHtml(columns, rows, {
      title: sourceName,
      additionalScript: this.getDialogScript(),
    }, toolbarButtons as ToolbarButton[]);
  }

  private updateThemeVariables(): void {
    if (!this._webviewPanel) { return; }
    const themeVars = getThemeCssVariables();
    this._webviewPanel.webview.postMessage({ type: 'updateTheme', cssVars: themeVars });
  }

  // ── Additional Inline Script (dialogs) ────────────────────────

  private getDialogScript(): string {
    return `
    // ── Toolbar action dispatcher ────────────────────────────
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'addLocaleResult') _handleAddLocaleResult(msg);
      if (msg.type === 'addKeyResult') _handleAddKeyResult(msg);
    });

    function _handleToolbarAction(id) {
      switch (id) {
        case 'addLang': _openAddLangDialog(); break;
        case 'addKey': _openAddKeyDialog(); break;
        case 'sortAZ': _notifyHost('sortRows', { ascending: true }); break;
        case 'viewMode': _notifyHost('setViewMode', { mode: 'toggle' }); break;
        case 'openAsText': _notifyHost('openAsText', {}); break;
      }
    }

    // Override handleToolbarAction from base
    const origToolbarAction = typeof handleToolbarAction === 'function' ? handleToolbarAction : null;
    // Replace the global handler
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
      el.innerHTML = '<div class="dialog-box"><div class="dialog-title">Add Language</div><div class="dialog-field"><input id="_addLangInput" class="dialog-input" type="text" placeholder="Locale code (e.g. ja, en-US, fr)" spellcheck="false" list="_addLangSuggestions" autocomplete="off"><datalist id="_addLangSuggestions"></datalist></div><div id="_addLangWarning" class="dialog-warning"></div><label class="dialog-checkbox-label"><input id="_addLangFillDefaults" type="checkbox" checked> Copy default values</label><div id="_addLangMessage" class="dialog-message"></div><div class="dialog-buttons"><button id="_addLangCancel" class="dialog-btn">Cancel</button><button id="_addLangOk" class="dialog-btn">OK</button></div></div>';
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
        warnEl.textContent = KNOWN_LOCALES.includes(v) ? '' : '\\u26A0 Unknown locale code';
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
      el.innerHTML = '<div class="dialog-box"><div class="dialog-title">Insert New Key Below</div><div class="dialog-field"><input id="_addKeyInput" class="dialog-input" type="text" placeholder="Resource key name" spellcheck="false" autocomplete="off"></div><label class="dialog-checkbox-label"><input id="_addKeyAddToAll" type="checkbox" checked> Add to all languages</label><div id="_addKeyMessage" class="dialog-message"></div><div class="dialog-buttons"><button id="_addKeyCancel" class="dialog-btn">Cancel</button><button id="_addKeyOk" class="dialog-btn">OK</button></div></div>';
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
        _notifyHost('addKey', { name, addToAll: document.getElementById('_addKeyAddToAll').checked, insertAfterIndex: window.__insertAfterIndex });
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
        setTimeout(() => {
          if (overlay) overlay.remove();
          // Host will rebuild the webview; no need for scrollIntoView
        }, 800);
      } else {
        msgEl.textContent = msg.message;
        msgEl.className = 'dialog-message error';
        if (okBtn) okBtn.disabled = false;
      }
    }

    // ── Delete Key dialog ───────────────────────────────────
    function _openDeleteKeyDialog(name, rowIdx) {
      let el = document.getElementById('_deleteKeyOverlay');
      if (el) el.remove();
      el = document.createElement('div');
      el.id = '_deleteKeyOverlay';
      el.className = 'dialog-overlay';
      el.innerHTML = '<div class="dialog-box"><div class="dialog-title">Delete Key</div><div class="dialog-message">Delete "' + escapeHtml(name) + '" from:</div><div class="dialog-buttons" style="flex-direction:column;gap:6px;"><button id="_deleteThisFile" class="dialog-btn danger">This file only</button><button id="_deleteAllFiles" class="dialog-btn danger">All locale files</button><button id="_deleteCancel" class="dialog-btn">Cancel</button></div></div>';
      document.body.appendChild(el);
      const close = () => { el.remove(); };
      document.getElementById('_deleteThisFile').addEventListener('click', () => { _notifyHost('deleteKey', { name, allFiles: false }); close(); });
      document.getElementById('_deleteAllFiles').addEventListener('click', () => { _notifyHost('deleteKey', { name, allFiles: true }); close(); });
      document.getElementById('_deleteCancel').addEventListener('click', close);
      el.addEventListener('click', (e) => { if (e.target === el) close(); });
    }

    // ── Action menu (dialogs triggered by host) ────────────────
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === '_openInsertKeyDialog') {
        _openAddKeyDialog(msg.rowIdx);
      } else if (msg.type === '_openDeleteKeyDialog') {
        _openDeleteKeyDialog(msg.name, msg.rowIdx);
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
      .dialog-input:focus { border-color: var(--resx-focus-border, var(--vscode-focusBorder)); box-shadow: 0 0 0 1px var(--resx-focus-border, var(--vscode-focusBorder)); }
      .dialog-checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; margin-bottom: 8px; color: var(--resx-fg); }
      .dialog-message { font-size: 13px; min-height: 16px; margin-bottom: 6px; line-height: 1.4; }
      .dialog-message.error { color: var(--vscode-notificationsErrorIcon-foreground, #f44); }
      .dialog-message.success { color: var(--vscode-notificationsInfoIcon-foreground, #3794ff); }
      .dialog-warning { font-size: 12px; color: var(--vscode-notificationsWarningIcon-foreground, #cca700); min-height: 15px; margin-bottom: 2px; line-height: 1.3; }
      .dialog-buttons { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
      .dialog-btn { padding: 5px 14px; border: none; border-radius: 2px; background: var(--resx-btn-bg, var(--vscode-button-background)); color: var(--resx-btn-fg, var(--vscode-button-foreground)); font-size: 13px; font-family: inherit; cursor: pointer; }
      .dialog-btn:hover { background: var(--resx-btn-hover, var(--vscode-button-hoverBackground)); }
      .dialog-btn.danger { background: transparent; color: var(--vscode-notificationsErrorIcon-foreground, #f44); border: 1px solid var(--vscode-notificationsErrorIcon-foreground, #f44); }
      .dialog-btn.danger:hover { background: rgba(255,80,80,0.1); }
    \`;
    document.head.appendChild(_dialogStyle);
    `;
  }

  // ── Webview Message Handling ────────────────────────────────────

  private async handleWebviewMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'cellEdited':
        await this.handleCellEdited(msg);
        break;
      case 'sortRows':
        this.handleSortRows(msg.ascending ?? true, true);
        break;
      case 'setViewMode':
        await this.handleSetViewMode(msg.mode === 'toggle' ? 'multi' : msg.mode);
        break;
      case 'openAsText':
        if (this._webviewPanel) {
          await this.openWithDefaultEditorAndClose(this._webviewPanel);
        }
        break;
      case 'addLocale':
        await this.handleAddLocale(msg.locale, msg.fillDefaults);
        break;
      case 'addKey':
        await this.handleAddKey(msg.name, msg.addToAll, msg.insertAfterIndex);
        break;
      case 'deleteKey':
        await this.handleDeleteKey(msg.name, msg.allFiles);
        break;
      case 'bulkEdit':
        await openBulkEditPanel(this.context, this.document.uri, msg.name);
        break;
      case 'setContextCell':
        this._contextCell = { row: msg.row, col: msg.col, isHeader: msg.isHeader, selectedRows: msg.selectedRows, name: msg.name };
        break;
      case 'copyToClipboard':
        await vscode.env.clipboard.writeText(msg.text);
        break;
      case 'actionMenu':
        await this.handleActionMenu(msg.actionId, msg.rowIdx);
        break;
    }
  }

  // ── Action Menu (from webview) ────────────────────────────────

  private async handleActionMenu(actionId: string, rowIdx: number): Promise<void> {
    if (rowIdx < 0 || rowIdx >= this.gridRows.length) { return; }
    const row = this.gridRows[rowIdx];
    if (!row) { return; }

    switch (actionId) {
      case 'bulkEdit':
        await openBulkEditPanel(this.context, this.document.uri, row.name);
        break;
      case 'insertBelow':
        // Delegate to webview dialog via postMessage
        this._webviewPanel?.webview.postMessage({ type: '_openInsertKeyDialog', rowIdx });
        break;
      case 'delete':
        this._webviewPanel?.webview.postMessage({ type: '_openDeleteKeyDialog', name: row.name, rowIdx });
        break;
    }
  }

  // ── Cell Edit ↁEImmediate File Write ──────────────────────────

  private async handleCellEdited(msg: { row: number; col: number; field?: string; locale?: string; oldValue: string; newValue: string }): Promise<void> {
    if (!this.localeSet || msg.row < 0 || msg.row >= this.gridRows.length) { return; }

    const row = this.gridRows[msg.row];
    if (!row) { return; }

    // Determine the column from the visible columns
    const visibleColumns = this.getVisibleColumns();
    const colDef = visibleColumns[msg.col];
    if (!colDef) { return; }

    this.isUpdating++;
    try {
      if (colDef.kind === 'name') {
        const oldName = row.name;
        await this.renameKeyAcrossAllLocales(oldName, msg.newValue);
        row.name = msg.newValue;
      } else if (colDef.kind === 'comment') {
        await this.updateCommentSingleLocale(row.name, msg.newValue, this.currentLocale);
        row.comment = msg.newValue;
      } else if (colDef.kind === 'locale') {
        const locale = colDef.locale;
        const doc = this.localeSet.locales.get(locale);
        if (doc) {
          const entry = doc.entries.find(e => e.name === row.name);
          if (entry) {
            entry.value = msg.newValue;
          } else {
            doc.entries.push({ name: row.name, value: msg.newValue, comment: '' });
          }
          await this.writeResxFile(doc);
          row.values.set(locale, msg.newValue);
        }
      }
    } finally {
      this.isUpdating--;
    }
  }

  // ── Action Handlers ──────────────────────────────────────────

  public async handleDeleteKey(name: string, allFiles: boolean): Promise<void> {
    if (!this.localeSet) { return; }

    this.isUpdating++;
    try {
      if (allFiles) {
        try { await this.document.save(); } catch {}
        await this.loadLocaleSet();
        for (const [, doc] of this.localeSet.locales) {
          doc.entries = doc.entries.filter(e => e.name !== name);
          await this.writeResxFile(doc);
        }
        try { await this.document.save(); } catch {}
        await this.loadLocaleSet();
      } else {
        const currentDoc = this.localeSet.locales.get(this.currentLocale);
        if (currentDoc) {
          currentDoc.entries = currentDoc.entries.filter(e => e.name !== name);
          await this.writeResxFile(currentDoc);
          try { await this.document.save(); } catch {}
          await this.loadLocaleSet();
        }
      }
      this.buildGrid();
      this.rebuildWebviewContent();
    } finally {
      this.isUpdating--;
    }
  }

  private async handleSetViewMode(mode: 'single' | 'multi'): Promise<void> {
    if (mode === 'multi') {
      // Open the MultiEdit virtual editor in a separate tab
      await openMultiEditPanel(this.context, this.document.uri);
    }
  }

  private async handleAddLocale(locale: string, fillDefaults: boolean): Promise<void> {
    if (!this.localeSet || !this._webviewPanel) { return; }

    if (this.localeSet.locales.has(locale)) {
      this._webviewPanel.webview.postMessage({
        type: 'addLocaleResult', success: false, locale,
        message: `Locale "${locale}" already exists.`,
      });
      return;
    }

    const fileName = this.localeSet.baseName.replace('.resx', `.${locale}.resx`);
    const filePath = path.join(this.localeSet.baseDir, fileName);
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

    this._webviewPanel.webview.postMessage({
      type: 'addLocaleResult', success: true, locale,
      message: `Language "${locale}" added successfully.`,
    });

    this.localeSet.locales.set(locale, doc);
    this.buildGrid();
    this.rebuildWebviewContent();

    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
  }

  private async handleAddKey(name: string, addToAll: boolean, insertAfterIndex?: number): Promise<void> {
    if (!this.localeSet || !this._webviewPanel) { return; }

    if (this.gridRows.some(r => r.name === name)) {
      this._webviewPanel.webview.postMessage({
        type: 'addKeyResult', success: false, name,
        message: `Key "${name}" already exists.`, rowIndex: -1,
      });
      return;
    }

    this.isUpdating++;
    try {
      const afterName = (insertAfterIndex != null && insertAfterIndex >= 0 && insertAfterIndex < this.gridRows.length)
        ? this.gridRows[insertAfterIndex].name
        : null;

      const addEntry = (doc: ResxDocument): void => {
        const entry: ResxEntry = { name, value: '', comment: '' };
        if (afterName) {
          const idx = doc.entries.findIndex(e => e.name === afterName);
          if (idx >= 0) { doc.entries.splice(idx + 1, 0, entry); }
          else { doc.entries.push(entry); }
        } else {
          doc.entries.push(entry);
        }
      };

      const defaultDoc = this.localeSet.locales.get(null);
      if (defaultDoc) {
        addEntry(defaultDoc);
        await this.writeResxFile(defaultDoc);
      }

      if (addToAll) {
        for (const [loc, doc] of this.localeSet.locales) {
          if (loc === null) { continue; }
          addEntry(doc);
          await this.writeResxFile(doc);
        }
      }

      this.buildGrid();
      const rowIndex = this.gridRows.findIndex(r => r.name === name);

      this._webviewPanel.webview.postMessage({
        type: 'addKeyResult', success: true, name,
        message: `Key "${name}" added successfully.`, rowIndex,
      });

      this.rebuildWebviewContent();
    } finally {
      this.isUpdating--;
    }
  }

  // ── File I/O ──────────────────────────────────────────────────

  private async renameKeyAcrossAllLocales(oldName: string, newName: string): Promise<void> {
    if (!this.localeSet) { return; }
    for (const [, doc] of this.localeSet.locales) {
      const entry = doc.entries.find(e => e.name === oldName);
      if (entry) {
        entry.name = newName;
      }
      await this.writeResxFile(doc);
    }
  }

  private async updateCommentSingleLocale(keyName: string, comment: string, targetLocale: string | null): Promise<void> {
    if (!this.localeSet) { return; }
    const doc = this.localeSet.locales.get(targetLocale);
    if (!doc) { return; }
    const entry = doc.entries.find(e => e.name === keyName);
    if (entry) {
      entry.comment = comment;
    } else {
      doc.entries.push({ name: keyName, value: '', comment });
    }
    await this.writeResxFile(doc);
  }

  private async writeResxFile(doc: ResxDocument): Promise<void> {
    const xml = serializeResx(doc);
    const uri = vscode.Uri.file(doc.path);

    if (doc.locale === this.currentLocale && uri.toString() === this.document.uri.toString()) {
      const fullRange = new vscode.Range(
        this.document.positionAt(0),
        this.document.positionAt(this.document.getText().length)
      );
      this.isUpdating++;
      try {
        this.lastWrittenUris.add(uri.toString());
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.replace(this.document.uri, fullRange, xml);
        const success = await vscode.workspace.applyEdit(wsEdit);
        if (!success) {
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(xml));
        }
        setTimeout(() => { this.lastWrittenUris.delete(uri.toString()); }, 2000);
      } finally {
        this.isUpdating--;
      }
    } else {
      this.lastWrittenUris.add(uri.toString());
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(xml));
      setTimeout(() => { this.lastWrittenUris.delete(uri.toString()); }, 2000);
    }
  }

  private async openWithDefaultEditorAndClose(webviewPanel: vscode.WebviewPanel): Promise<void> {
    try {
      const opts: any = {
        viewColumn: webviewPanel.viewColumn,
        preserveFocus: !webviewPanel.active,
        preview: !!webviewPanel.active
      };
      await vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'default', opts);
    } finally {
      try { webviewPanel.dispose(); } catch {}
    }
  }

  private async reloadAndRefresh(): Promise<void> {
    if (this.isUpdating > 0) { return; }
    await this.loadLocaleSet();
    this.rebuildWebviewContent();
  }

  // ── File Watching ───────────────────────────────────────────

  private setupFileWatchers(): void {
    for (const w of this.fileWatchers) { w.dispose(); }
    this.fileWatchers = [];

    if (!this.localeSet) { return; }

    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(this.localeSet.baseDir) as unknown as vscode.WorkspaceFolder,
      '*.resx'
    );

    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(async (uri) => {
      if (uri.toString() === this.document.uri.toString()) { return; }
      const fileName = path.basename(uri.fsPath);
      const parsed = parseResxFilename(fileName);
      if (parsed.baseName.toLowerCase() !== this.localeSet!.baseName.toLowerCase()) { return; }
      try {
        const content = await vscode.workspace.fs.readFile(uri);
        const xmlText = new TextDecoder('utf-8').decode(content);
        const doc = parseResx(xmlText, uri.fsPath);
        doc.locale = parsed.locale;
        this.localeSet!.locales.set(parsed.locale, doc);
        this.buildGrid();
        this.rebuildWebviewContent();
      } catch (err) {
        console.warn(`RESX: failed to reload ${uri.fsPath}`, err);
      }
    });

    watcher.onDidCreate(async (uri) => {
      const fileName = path.basename(uri.fsPath);
      const parsed = parseResxFilename(fileName);
      if (parsed.baseName.toLowerCase() !== this.localeSet!.baseName.toLowerCase()) { return; }
      if (this.localeSet!.locales.has(parsed.locale)) { return; }
      try {
        const content = await vscode.workspace.fs.readFile(uri);
        const xmlText = new TextDecoder('utf-8').decode(content);
        const doc = parseResx(xmlText, uri.fsPath);
        doc.locale = parsed.locale;
        this.localeSet!.locales.set(parsed.locale, doc);
        this.buildGrid();
        this.rebuildWebviewContent();
      } catch (err) {
        console.warn(`RESX: failed to load new locale file ${uri.fsPath}`, err);
      }
    });

    watcher.onDidDelete((uri) => {
      const fileName = path.basename(uri.fsPath);
      const parsed = parseResxFilename(fileName);
      if (parsed.baseName.toLowerCase() !== this.localeSet!.baseName.toLowerCase()) { return; }
      if (parsed.locale === null) { return; }
      this.localeSet!.locales.delete(parsed.locale);
      this.buildGrid();
      this.rebuildWebviewContent();
    });

    this.fileWatchers.push(watcher);
  }

  // ── Public API (for commands.ts) ──────────────────────────────

  public refresh(): void {
    if (this._webviewPanel) {
      this.forceReload();
    }
  }

  private forceReload(): void {
    if (!this._webviewPanel) { return; }
    this._webviewPanel.webview.html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body></body></html>';
    setTimeout(() => {
      try { this.reloadAndRefresh(); } catch (e) { console.error('RESX: forceReload failed', e); }
    }, 0);
  }

  public isActive(): boolean {
    return !!this._webviewPanel?.active;
  }

  public getDocumentUri(): vscode.Uri {
    return this.document.uri;
  }

  public handleSortRows(ascending: boolean, writeImmediately: boolean = true): void {
    this.gridRows.sort((a, b) => {
      const cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      return ascending ? cmp : -cmp;
    });

    if (this.localeSet) {
      this.isUpdating++;
      try {
        const sortedNames = this.gridRows.map(r => r.name);
        if (writeImmediately) {
          for (const [, doc] of this.localeSet.locales) {
            const entryMap = new Map(doc.entries.map(e => [e.name, e]));
            doc.entries = sortedNames
              .map(name => entryMap.get(name))
              .filter((e): e is ResxEntry => !!e);
            this.writeResxFile(doc);
          }
        } else {
          const currentDoc = this.localeSet.locales.get(this.currentLocale);
          if (currentDoc) {
            const entryMap = new Map(currentDoc.entries.map(e => [e.name, e]));
            currentDoc.entries = sortedNames
              .map(name => entryMap.get(name))
              .filter((e): e is ResxEntry => !!e);
            this.writeResxFile(currentDoc);
          }
        }
      } finally {
        this.isUpdating--;
      }
    }

    this.rebuildWebviewContent();
  }
}

// ─────────────────────────────────────────────────────────────────────
// ResxEditProvider  EVS Code CustomTextEditorProvider wrapper.
// ─────────────────────────────────────────────────────────────────────

export class ResxEditProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'resx.editor';
  public static controllers: ResxEditController[] = [];
  public static currentActive: ResxEditController | undefined;
  public static readonly serialKey = 'resx.serialIndexByUri';

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    console.log(`RESX(resx-edit): creating controller for ${document.uri.toString()}`);
    const controller = new ResxEditController(this.context);

    webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        ResxEditProvider.currentActive = controller;
      }
    });

    await controller.resolveCustomTextEditor(document, webviewPanel, token);
  }

  public static getActiveController(): ResxEditController | undefined {
    return ResxEditProvider.currentActive || ResxEditProvider.controllers.find(c => c.isActive());
  }

  public static getSerialIndexForUri(context: vscode.ExtensionContext, uri: vscode.Uri): boolean {
    const map = context.workspaceState.get<Record<string, boolean>>(ResxEditProvider.serialKey, {});
    return map[uri.toString()] ?? true;
  }

  public static async setSerialIndexForUri(context: vscode.ExtensionContext, uri: vscode.Uri, val: boolean): Promise<void> {
    const map = { ...(context.workspaceState.get<Record<string, boolean>>(ResxEditProvider.serialKey, {})) };
    map[uri.toString()] = !!val;
    await context.workspaceState.update(ResxEditProvider.serialKey, map);
  }
}
