import * as vscode from 'vscode';
import * as path from 'path';
import {
  ResxLocaleSet, ResxGridColumn, ResxGridRow,
  ResxDocument, ResxEntry, WebviewToHostMessage
} from './types/resx';
import { parseResx, encodeXmlEntities } from './resx-parser';
import { serializeResx } from './resx-writer';
import { findRelatedResxFiles, getSortedLocales, parseResxFilename } from './resx-locale-finder';
import { openBulkEditPanel } from './bulk-edit-panel';
import { getThemeCssVariables } from './theme-colors';

// ─────────────────────────────────────────────────────────────────────
// ResxEditorController — manages one webview + one locale set.
// ─────────────────────────────────────────────────────────────────────

class ResxEditorController {
  private currentWebviewPanel: vscode.WebviewPanel | undefined;
  private document!: vscode.TextDocument;
  private localeSet: ResxLocaleSet | null | undefined;
  private columns: ResxGridColumn[] = [];
  private gridRows: ResxGridRow[] = [];
  private isUpdating = false;
  private lastWrittenUris = new Set<string>();
  private fileWatchers: vscode.FileSystemWatcher[] = [];
  private highlightMissing = true;
  private viewMode: 'single' | 'multi' = 'single';
  /** The locale of the currently-open document (null = default/culture-invariant). */
  private currentLocale: string | null = null;

  /** Context menu cell info (set by webview on right-click for VSCode context menu commands). */
  private _contextCell: { row: number; col: number; isHeader: boolean; selectedRows: number[]; name: string } | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Get the context cell info for context menu commands. */
  public getContextCell() { return this._contextCell; }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.document = document;
    this.currentLocale = parseResxFilename(path.basename(document.uri.fsPath)).locale ?? null;
    this.currentWebviewPanel = webviewPanel;
    ResxEditorProvider.editors.push(this);

    // Detect diff/compare view or untitled scheme — fall back to default text editor
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

    // Always start in single mode (multi is a session-only toggle).
    this.viewMode = 'single';

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };

    // Load locale set
    await this.loadLocaleSet();

    // Render
    this.updateWebviewContent();

    // Listen for external file changes to related locale files
    this.setupFileWatchers();

    if (webviewPanel.active) {
      ResxEditorProvider.currentActive = this;
    }



    // Handle messages from the webview
    webviewPanel.webview.onDidReceiveMessage(async (e: WebviewToHostMessage) => {
      await this.handleWebviewMessage(e);
    });

    // Watch for changes to the current document made outside our editor
    const changeSub = vscode.workspace.onDidChangeTextDocument(ev => {
      if (
        ev.document.uri.toString() === document.uri.toString() &&
        !this.isUpdating &&
        !this.lastWrittenUris.has(ev.document.uri.toString())
      ) {
        setTimeout(() => this.reloadAndRefresh(), 300);
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      for (const w of this.fileWatchers) { w.dispose(); }
      this.fileWatchers = [];
      ResxEditorProvider.editors = ResxEditorProvider.editors.filter(ed => ed !== this);
      this.currentWebviewPanel = undefined;
    });

    webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        ResxEditorProvider.currentActive = this;
        this.updateWebviewContent();
      }
    });

    // Re-render when the color theme changes so CSS variables stay in sync
    const colorThemeSub = vscode.window.onDidChangeActiveColorTheme(() => {
      this.updateWebviewContent();
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      colorThemeSub.dispose();
      for (const w of this.fileWatchers) { w.dispose(); }
      this.fileWatchers = [];
      ResxEditorProvider.editors = ResxEditorProvider.editors.filter(ed => ed !== this);
      this.currentWebviewPanel = undefined;
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

    const currentLocale = parseResxFilename(path.basename(this.document.uri.fsPath)).locale ?? null;
    const sortedLocales = getSortedLocales(this.localeSet, currentLocale);

    // Build columns: index, name, comment, then each locale
    this.columns = [];
    this.columns.push({ kind: 'index', locale: null, label: '#' });
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
    // Collect all unique names across all locale files
    const nameOrder: string[] = [];
    const nameSet = new Set<string>();

    // Iterate in locale order so default file determines name order
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
      const row: ResxGridRow = { name, comment: '', values: new Map() };
      for (const loc of sortedLocales) {
        const doc = this.localeSet!.locales.get(loc)!;
        const entry = doc.entries.find(e => e.name === name);
        if (entry) {
          row.values.set(loc, entry.value);
          // Use comment from whichever file has it (prefer default/null)
          if (entry.comment && (!row.comment || loc === null)) {
            row.comment = entry.comment;
          }
        }
      }
      return row;
    });
  }

  /**
   * Returns the columns that should be visible based on the current view mode.
   * In 'single' mode, only Name, Comment, Default, and the current file's locale are shown.
   * In 'multi' mode, all columns are returned.
   * Each returned element includes `physicalIndex` — the index in `this.columns`.
   */
  private getVisibleColumns(): Array<ResxGridColumn & { physicalIndex: number }> {
    const currentLocale = parseResxFilename(path.basename(this.document.uri.fsPath)).locale ?? null;

    if (this.viewMode === 'multi') {
      return this.columns.map((c, i) => ({ ...c, physicalIndex: i }));
    }

    // Single mode: index, name, comment, then default (if current is not default), then current locale
    const visible: Array<ResxGridColumn & { physicalIndex: number }> = [];
    for (let i = 0; i < this.columns.length; i++) {
      const c = this.columns[i];
      if (c.kind === 'index' || c.kind === 'name' || c.kind === 'comment') {
        visible.push({ ...c, physicalIndex: i });
      } else if (c.kind === 'locale') {
        // Show default locale column and current file's locale column
        if (c.locale === null) {
          visible.push({ ...c, physicalIndex: i });
        } else if (c.locale === currentLocale) {
          visible.push({ ...c, physicalIndex: i });
        }
      }
    }
    return visible;
  }

  // ── File Watching ───────────────────────────────────────────────

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
      // Skip the currently-active document — handled by onDidChangeTextDocument
      if (uri.toString() === this.document.uri.toString()) { return; }

      const fileName = path.basename(uri.fsPath);
      const parsed = parseResxFilename(fileName);
      if (parsed.baseName.toLowerCase() !== this.localeSet!.baseName.toLowerCase()) { return; }

      // Reload the changed file
      try {
        const content = await vscode.workspace.fs.readFile(uri);
        const xmlText = new TextDecoder('utf-8').decode(content);
        const doc = parseResx(xmlText, uri.fsPath);
        doc.locale = parsed.locale;
        this.localeSet!.locales.set(parsed.locale, doc);
        this.buildGrid();
        this.updateWebviewContent();
      } catch (err) {
        console.warn(`RESX: failed to reload ${uri.fsPath}`, err);
      }
    });

    // Detect new locale files being created
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
        this.updateWebviewContent();
      } catch (err) {
        console.warn(`RESX: failed to load new locale file ${uri.fsPath}`, err);
      }
    });

    watcher.onDidDelete((uri) => {
      const fileName = path.basename(uri.fsPath);
      const parsed = parseResxFilename(fileName);
      if (parsed.baseName.toLowerCase() !== this.localeSet!.baseName.toLowerCase()) { return; }
      if (parsed.locale === null) { return; } // don't remove default file

      this.localeSet!.locales.delete(parsed.locale);
      this.buildGrid();
      this.updateWebviewContent();
    });

    this.fileWatchers.push(watcher);
  }

  // ── Webview Message Handling ────────────────────────────────────

  private async handleWebviewMessage(msg: WebviewToHostMessage): Promise<void> {
    switch (msg.type) {
      case 'editCell':
        await this.handleEditCell(msg.row, msg.col, msg.value);
        break;
      case 'insertRow':
        await this.handleInsertRow(msg.index);
        break;
      case 'deleteRows':
        await this.handleDeleteRows(msg.indices);
        break;
      case 'renameKey':
        await this.handleRenameKey(msg.row, msg.newName);
        break;
      case 'sortRows':
        this.handleSortRows(msg.ascending);
        break;
      case 'addLocale':
        await this.handleAddLocale(msg.locale);
        break;
      case 'copyToClipboard':
        await vscode.env.clipboard.writeText(msg.text);
        break;
      case 'findMatches':
        await this.handleFindMatches(msg.requestId, msg.query, msg.options);
        break;
      case 'replaceMatches':
        await this.handleReplaceMatches(msg.requestId, msg.replacements);
        break;
      case 'openAsText':
        if (this.currentWebviewPanel) {
          await this.openWithDefaultEditorAndClose(this.currentWebviewPanel);
        }
        break;
      case 'setViewMode':
        await this.handleSetViewMode(msg.mode);
        break;
      case 'bulkEdit':
        await openBulkEditPanel(this.context, this.document.uri, msg.name);
        break;
      case 'setContextCell':
        this._contextCell = { row: msg.row, col: msg.col, isHeader: msg.isHeader, selectedRows: msg.selectedRows, name: msg.name };
        break;
    }
  }

  private getColumnByIndex(colIndex: number): ResxGridColumn | undefined {
    return this.columns[colIndex];
  }

  private async handleEditCell(row: number, col: number, value: string): Promise<void> {
    if (!this.localeSet || row < 0 || row >= this.gridRows.length) { return; }
    const column = this.getColumnByIndex(col);
    if (!column) { return; }

    this.isUpdating = true;
    try {
      if (column.kind === 'name') {
        // Rename the key across all locale files
        const oldName = this.gridRows[row].name;
        await this.renameKeyAcrossAllLocales(oldName, value);
        this.gridRows[row].name = value;
      } else if (column.kind === 'comment') {
        if (this.viewMode === 'multi') {
          // Multi mode: update comment in default locale file only
          await this.updateCommentSingleLocale(this.gridRows[row].name, value, null);
        } else {
          // Single mode: update comment in the currently open file only
          const currentLocale = parseResxFilename(path.basename(this.document.uri.fsPath)).locale ?? null;
          await this.updateCommentSingleLocale(this.gridRows[row].name, value, currentLocale);
        }
        this.gridRows[row].comment = value;
      } else if (column.kind === 'locale') {
        // Update value in the specific locale file
        const locale = column.locale;
        const doc = this.localeSet.locales.get(locale);
        if (doc) {
          const entry = doc.entries.find(e => e.name === this.gridRows[row].name);
          if (entry) {
            entry.value = value;
          } else {
            doc.entries.push({ name: this.gridRows[row].name, value, comment: '' });
          }
          await this.writeResxFile(doc);
          this.gridRows[row].values.set(locale, value);
        }
      }

      // Notify webview of the update
      const rendered = this.formatCellContent(value);
      const config = vscode.workspace.getConfiguration('resx', this.document.uri);
      const highlight = config.get<boolean>('highlightMissingTranslations', true);
      const missingClass = highlight ? this.getMissingCellStyle(row, column) : '';
      this.currentWebviewPanel?.webview.postMessage({
        type: 'updateCell',
        row,
        col,
        value,
        rendered,
        missingClass
      });
    } finally {
      this.isUpdating = false;
    }
  }

  public async handleInsertRow(index: number): Promise<void> {
    if (!this.localeSet) { return; }
    // Generate a new unique name
    const baseName = 'new_key';
    let name = baseName;
    let counter = 1;
    const existingNames = new Set(this.gridRows.map(r => r.name));
    while (existingNames.has(name)) {
      name = `${baseName}_${counter++}`;
    }

    this.isUpdating = true;
    try {
      // Insert into all locale files
      for (const [locale, doc] of this.localeSet.locales) {
        const entry: ResxEntry = { name, value: '', comment: '' };
        if (index >= 0 && index < doc.entries.length) {
          // Try to insert at the right position
          const targetName = this.gridRows[index]?.name;
          const targetIdx = doc.entries.findIndex(e => e.name === targetName);
          if (targetIdx >= 0) {
            doc.entries.splice(targetIdx, 0, entry);
          } else {
            doc.entries.push(entry);
          }
        } else {
          doc.entries.push(entry);
        }
        await this.writeResxFile(doc);
      }

      this.buildGrid();
      this.updateWebviewContent();
    } finally {
      this.isUpdating = false;
    }
  }

  public async handleDeleteRows(indices: number[]): Promise<void> {
    if (!this.localeSet || !indices.length) { return; }
    const namesToDelete = new Set(indices.map(i => this.gridRows[i]?.name).filter(Boolean));

    this.isUpdating = true;
    try {
      for (const [, doc] of this.localeSet.locales) {
        doc.entries = doc.entries.filter(e => !namesToDelete.has(e.name));
        await this.writeResxFile(doc);
      }

      this.buildGrid();
      this.updateWebviewContent();
    } finally {
      this.isUpdating = false;
    }
  }

  private async handleRenameKey(row: number, newName: string): Promise<void> {
    if (!this.localeSet || row < 0 || row >= this.gridRows.length) { return; }
    const oldName = this.gridRows[row].name;
    if (oldName === newName) { return; }
    await this.renameKeyAcrossAllLocales(oldName, newName);
    this.gridRows[row].name = newName;
    this.updateWebviewContent();
  }

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

  private async updateCommentAcrossAllLocales(keyName: string, comment: string): Promise<void> {
    if (!this.localeSet) { return; }
    for (const [, doc] of this.localeSet.locales) {
      const entry = doc.entries.find(e => e.name === keyName);
      if (entry) {
        entry.comment = comment;
      } else {
        // Create entry with empty value but with comment
        doc.entries.push({ name: keyName, value: '', comment });
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

  public handleSortRows(ascending: boolean): void {
    this.gridRows.sort((a, b) => {
      const cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      return ascending ? cmp : -cmp;
    });

    // Rebuild entries in all locale files to match the sorted order
    if (this.localeSet) {
      this.isUpdating = true;
      try {
        const sortedNames = this.gridRows.map(r => r.name);
        for (const [, doc] of this.localeSet.locales) {
          const entryMap = new Map(doc.entries.map(e => [e.name, e]));
          doc.entries = sortedNames
            .map(name => entryMap.get(name))
            .filter((e): e is ResxEntry => !!e);
          // Append any entries not in the sorted list (shouldn't happen but safety)
          this.writeResxFile(doc);
        }
      } finally {
        this.isUpdating = false;
      }
    }

    this.updateWebviewContent();
  }

  private async handleAddLocale(locale: string): Promise<void> {
    if (!this.localeSet) { return; }
    if (this.localeSet.locales.has(locale)) { return; }

    // Create a new .resx file for this locale
    const fileName = this.localeSet.baseName.replace('.resx', `.${locale}.resx`);
    const filePath = path.join(this.localeSet.baseDir, fileName);
    const doc: ResxDocument = {
      path: filePath,
      locale,
      entries: this.gridRows.map(r => ({
        name: r.name,
        value: '',
        comment: r.comment,
      })),
    };

    const xml = serializeResx(doc);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      new TextEncoder().encode(xml)
    );

    this.localeSet.locales.set(locale, doc);
    this.buildGrid();
    this.updateWebviewContent();
  }

  // ── Editability helpers ──────────────────────────────────────────

  /** Returns true if the cell at the given physical column index is user-editable. */
  private isCellEditable(physCol: number): boolean {
    const column = this.columns[physCol];
    if (!column) { return false; }

    // Index column is always read-only
    if (column.kind === 'index') { return false; }

    // Multi mode: everything except index is editable
    if (this.viewMode === 'multi') { return true; }

    // Single mode + default file: all non-index cells editable
    if (this.currentLocale === null) { return true; }

    // Single mode + non-default file: lock name and default locale columns
    if (column.kind === 'name') { return false; }
    if (column.kind === 'locale' && column.locale === null) { return false; }

    return true;
  }

  private async handleFindMatches(
    requestId: number,
    query: string,
    options: { regex: boolean; wholeWord: boolean; matchCase: boolean }
  ): Promise<void> {
    if (!this.currentWebviewPanel || !query) {
      this.currentWebviewPanel?.webview.postMessage({
        type: 'findMatchesResult', requestId, matches: [], invalidRegex: false
      });
      return;
    }

    let regex: RegExp | undefined;
    try {
      let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (options.wholeWord) { source = `\\b(?:${source})\\b`; }
      regex = new RegExp(source, options.matchCase ? 'g' : 'gi');
    } catch {
      this.currentWebviewPanel?.webview.postMessage({
        type: 'findMatchesResult', requestId, matches: [], invalidRegex: true
      });
      return;
    }

    const matches: Array<{ row: number; col: number; value: string }> = [];
    for (let r = 0; r < this.gridRows.length; r++) {
      const row = this.gridRows[r];
      const cellValues = [
        { col: 1, value: row.name },       // Name column
        { col: 2, value: row.comment },     // Comment column
        ...this.columns.slice(3).map((c, idx) => ({
          col: 3 + idx,
          value: row.values.get(c.locale) ?? ''
        }))
      ];
      for (const cell of cellValues) {
        if (!this.isCellEditable(cell.col)) { continue; }
        regex.lastIndex = 0;
        if (regex.test(cell.value)) {
          matches.push({ row: r, col: cell.col, value: cell.value });
        }
      }
    }

    this.currentWebviewPanel.webview.postMessage({
      type: 'findMatchesResult', requestId, matches, invalidRegex: false
    });
  }

  private async handleReplaceMatches(
    requestId: number,
    replacements: Array<{ row: number; col: number; value: string }>
  ): Promise<void> {
    if (!replacements.length) { return; }

    for (const repl of replacements) {
      if (!this.isCellEditable(repl.col)) { continue; }
      await this.handleEditCell(repl.row, repl.col, repl.value);
    }

    this.currentWebviewPanel?.webview.postMessage({
      type: 'replaceMatchesResult', requestId
    });
  }

  private async handleSetViewMode(mode: 'single' | 'multi'): Promise<void> {
    if (mode === this.viewMode) { return; }

    // Auto-save before switching to prevent data loss
    try {
      await this.document.save();
    } catch {
      // Ignore save errors (e.g. untitled or readonly files)
    }

    this.viewMode = mode;

    this.updateWebviewContent();
  }

  // ── File I/O ────────────────────────────────────────────────────

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

  private async writeResxFile(doc: ResxDocument): Promise<void> {
    const xml = serializeResx(doc);
    const uri = vscode.Uri.file(doc.path);

    // If this is the currently-open backing document, use workspace.applyEdit
    // so that VS Code tracks dirty state, timeline entries, and fires onDidSaveTextDocument.
    if (doc.locale === this.currentLocale && uri.toString() === this.document.uri.toString()) {
      const fullRange = new vscode.Range(
        this.document.positionAt(0),
        this.document.positionAt(this.document.getText().length)
      );
      this.isUpdating = true;
      try {
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.replace(this.document.uri, fullRange, xml);
        const success = await vscode.workspace.applyEdit(wsEdit);
        if (!success) {
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(xml));
        }
      } finally {
        this.isUpdating = false;
      }
    } else {
      // Other locale file — write directly to disk
      this.lastWrittenUris.add(uri.toString());
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(xml));
      setTimeout(() => { this.lastWrittenUris.delete(uri.toString()); }, 500);
    }
  }

  private async reloadAndRefresh(): Promise<void> {
    // Re-read the main document and rebuild
    await this.loadLocaleSet();
    this.updateWebviewContent();
  }

  // ── Public API ──────────────────────────────────────────────────

  public refresh(): void {
    if (this.currentWebviewPanel) {
      this.forceReload();
    }
  }

  private forceReload(): void {
    if (!this.currentWebviewPanel) { return; }
    const panel = this.currentWebviewPanel;
    panel.webview.html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body></body></html>';
    setTimeout(() => {
      try { this.reloadAndRefresh(); } catch (e) { console.error('RESX: forceReload failed', e); }
    }, 0);
  }

  public isActive(): boolean {
    return !!this.currentWebviewPanel?.active;
  }

  public getDocumentUri(): vscode.Uri {
    return this.document.uri;
  }

  // ── Webview Rendering ───────────────────────────────────────────

  private getMissingCellStyle(row: number, column: ResxGridColumn): string {
    if (!this.highlightMissing || column.kind !== 'locale' || column.locale === null) { return ''; }
    const value = this.gridRows[row]?.values.get(column.locale) ?? '';
    const defaultValue = this.gridRows[row]?.values.get(null) ?? '';
    // "Missing" = value is empty, or value equals default value (untranslated)
    if (!value || value === defaultValue) { return ' missing-translation'; }
    return '';
  }

  private formatCellContent(text: string, _linkify?: boolean): string {
    return this.escapeHtml(text);
  }

  private escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, m => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[m] as string);
  }

  private updateWebviewContent(): void {
    if (!this.currentWebviewPanel || !this.localeSet) { return; }

    const webview = this.currentWebviewPanel.webview;
    const config = vscode.workspace.getConfiguration('resx', this.document.uri);
    const fontFamily =
      config.get<string>('fontFamily') ||
      vscode.workspace.getConfiguration('editor').get<string>('fontFamily', 'Menlo');
    const csvFontSize = config.get<number>('fontSize', 0);
    const editorFontSize = vscode.workspace.getConfiguration('editor').get<number>('fontSize', 14);
    const fontSize = (typeof csvFontSize === 'number' && csvFontSize > 0) ? csvFontSize : (editorFontSize || 14);
    const cellPadding = config.get<number>('cellPadding', 4);
    this.highlightMissing = config.get<boolean>('highlightMissingTranslations', true);
    const mouseWheelZoomEnabled = config.get<boolean>('mouseWheelZoom', true);
    const mouseWheelZoomInvert = config.get<boolean>('mouseWheelZoomInvert', false);
    const singleClickEdit = config.get<boolean>('singleClickEdit', false);
    const addSerialIndex = config.get<boolean>('showSerialIndex', true);

    const themeVars = getThemeCssVariables();

    // Generate table HTML
    const tableHtml = this.generateTableHtml(addSerialIndex);

    const nonce = this.getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'main.js'))
    );

    // Column metadata for the webview
    const columnsJson = JSON.stringify(this.columns);
    const rowsCount = this.gridRows.length;
    const defaultLocaleExists = this.localeSet.locales.has(null);
    const defaultValues = JSON.stringify(
      this.gridRows.map(r => r.values.get(null) ?? '')
    );

    this.currentWebviewPanel.webview.html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; img-src ${webview.cspSource} https:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RESX</title>
    <style nonce="${nonce}">
      :root {
    ${themeVars}
      }
      body { font-family: ${this.escapeCss(fontFamily)}; font-size: ${fontSize}px; margin: 0; padding: 0; user-select: none; }
      .table-container { overflow: auto; height: calc(100vh - 33px); }
      table { border-collapse: collapse; width: max-content; }
      th, td { padding: ${cellPadding}px 8px; border: 1px solid var(--resx-border); font-size: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      th { position: sticky; top: 0; background-color: var(--resx-body); z-index: 10; user-select: none; }
      td { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      td:hover { overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; }
      td.selected, th.selected { background-color: var(--resx-selected-bg) !important; }
      td.editing, th.editing { overflow: visible !important; white-space: pre-wrap !important; overflow-wrap: anywhere !important; max-width: none !important; }
      .highlight { background-color: var(--resx-highlight-bg) !important; }
      .active-match { background-color: var(--resx-active-match-bg) !important; }
      td.missing-translation { background-color: var(--resx-missing-bg) !important; }
      td.missing-translation.selected { background-color: var(--resx-missing-selected-bg) !important; }
      .locale-header { cursor: default; }
      .name-col { min-width: 60px; width: 120px; max-width: 120px; }
      .value-col { min-width: 80px; width: 160px; max-width: 180px; }
      .index-col { min-width: 40px; max-width: 50px; color: var(--resx-index-fg); text-align: right; }
      .comment-col { min-width: 60px; width: 120px; max-width: 120px; }
      #findReplaceWidget {
        position: fixed; top: 12px; right: 20px; width: 592px; min-width: 592px; max-width: 592px;
        background: var(--fr-bg); border: 1px solid var(--fr-border); border-radius: 8px; padding: 10px;
        box-shadow: 0 6px 18px rgba(0,0,0,0.25); z-index: 1200; display: none; align-items: stretch;
        color: var(--fr-fg); font-family: ${this.escapeCss(fontFamily)}; font-size: inherit;
      }
      #findReplaceWidget.open { display: flex; }
      #findReplaceWidget .fr-gutter { width: 24px; min-width: 24px; border-radius: 6px; background: var(--fr-gutter-bg); border-right: 1px solid var(--fr-gutter-border); margin-right: 10px; display: flex; align-items: center; justify-content: center; }
      #findReplaceWidget .fr-content { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
      #findReplaceWidget.replace-collapsed .fr-row-replace { display: none; }
      #findReplaceWidget .fr-row { display: flex; align-items: center; gap: 8px; }
      #findReplaceWidget .fr-row-find .fr-input-wrap { flex: 0 0 calc(25ch + 118px); width: calc(25ch + 118px); }
      #findReplaceWidget .fr-row-replace .fr-input-wrap { flex: 0 0 calc(25ch + 54px); width: calc(25ch + 54px); }
      #findReplaceWidget .fr-input-wrap { position: relative; flex: 1 1 auto; min-width: 0; }
      #findReplaceWidget .fr-input { width: 100%; height: 36px; box-sizing: border-box; border: 1px solid var(--fr-input-border); border-radius: 6px; background: var(--fr-input-bg); color: var(--fr-input-fg); padding-left: 10px; font-size: inherit; outline: none; }
      #findReplaceWidget .fr-input::placeholder { color: var(--fr-input-placeholder); }
      #findReplaceWidget .fr-input:focus { border-color: var(--fr-input-focus-border); box-shadow: var(--fr-input-focus-shadow); }
      #findInput { padding-right: 118px; }
      #replaceInput { padding-right: 54px; }
      #findReplaceWidget .fr-inline-toggles { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 4px; padding-left: 6px; border-left: 1px solid var(--fr-divider-separator); }
      #findReplaceWidget .fr-toggle-btn { min-width: 24px; height: 24px; border: 0; border-radius: 4px; background: transparent; color: var(--fr-btn-fg); font-size: 0.86em; cursor: pointer; padding: 0 4px; }
      #findReplaceWidget .fr-toggle-btn:hover { background: var(--fr-btn-hover-bg); color: var(--fr-toggle-active-color); }
      #findReplaceWidget .fr-toggle-btn[aria-pressed="true"] { color: var(--fr-toggle-active-color); box-shadow: inset 0 -2px 0 var(--fr-toggle-active-color); }
      #findReplaceWidget .fr-status { min-width: 84px; text-align: right; color: var(--fr-status-fg); font-size: inherit; }
      #findReplaceWidget .fr-divider { width: 1px; height: 22px; background: var(--fr-divider); }
      #findReplaceWidget .fr-icon-btn, #findReplaceWidget .fr-action-btn, #findReplaceWidget .fr-caret-btn { width: 28px; height: 28px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--fr-btn-fg); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0; }
      #findReplaceWidget .fr-icon-btn:hover, #findReplaceWidget .fr-action-btn:hover, #findReplaceWidget .fr-caret-btn:hover { background: var(--fr-btn-hover-bg); color: var(--fr-toggle-active-color); }
      #findReplaceWidget .fr-icon-btn[disabled], #findReplaceWidget .fr-action-btn[disabled] { opacity: 0.5; cursor: default; pointer-events: none; }
      #findReplaceWidget .fr-close-btn:hover { background: var(--fr-close-hover-bg); color: var(--fr-close-hover-fg); }
      #findReplaceWidget .fr-actions { display: flex; align-items: center; gap: 8px; }
      #findReplaceWidget .fr-overflow-menu { position: absolute; top: 48px; right: 44px; min-width: 200px; background: var(--fr-overflow-bg); border: 1px solid var(--fr-overflow-border); border-radius: 6px; box-shadow: 0 10px 24px rgba(0,0,0,0.25); padding: 4px; display: none; }
      #findReplaceWidget .fr-overflow-menu.open { display: block; }
      #findReplaceWidget .fr-overflow-item { width: 100%; border: 0; background: transparent; color: var(--fr-fg); border-radius: 4px; text-align: left; padding: 6px 8px; cursor: pointer; font-size: inherit; }
      #findReplaceWidget .fr-overflow-item:hover { background: var(--fr-btn-hover-bg); }
      #toolbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 8px; padding: 4px 8px; background: var(--resx-header-bg); border-bottom: 1px solid var(--resx-toolbar-border); }
      #toolbar button { padding: 2px 10px; border: 1px solid var(--resx-btn-border); border-radius: 3px; background: var(--resx-btn-bg); color: var(--resx-btn-fg); font-size: 12px; cursor: pointer; white-space: nowrap; }
      #toolbar button:hover { background: var(--resx-btn-hover); }
    </style>
  </head>
  <body>
    <div id="toolbar">
      <button id="viewModeBtn" title="${this.viewMode === 'single' ? 'Show all locale columns' : 'Show single file columns'}">${this.viewMode === 'single' ? 'Multi View' : 'Single View'}</button>
      <button id="openAsTextBtn" title="Open this file in the default text editor">Open as Text</button>
    </div>
    <div id="csv-root" class="table-container"
         data-resx="1"
         data-defaultvalues="${this.escapeAttr(defaultValues)}"
         data-defaultlocale="${defaultLocaleExists ? '1' : '0'}"
         data-fontsize="${fontSize}"
         data-wheelzoomenabled="${mouseWheelZoomEnabled ? '1' : '0'}"
         data-wheelzoominvert="${mouseWheelZoomInvert ? '1' : '0'}"
         data-singleclickedit="${singleClickEdit ? '1' : '0'}"
         data-rowscount="${rowsCount}">
      ${tableHtml}
    </div>
    <script id="__csvChunks" type="application/json" nonce="${nonce}">[]</script>
    <script id="__resxColumns" type="application/json" nonce="${nonce}">${columnsJson}</script>
    <div id="findReplaceWidget" class="replace-collapsed" role="group" aria-label="Find and Replace">
      <div id="replaceToggleGutter" class="fr-gutter">
        <button id="replaceToggle" class="fr-caret-btn" type="button" aria-label="Toggle Replace" aria-expanded="false">›</button>
      </div>
      <div class="fr-content">
        <div class="fr-row fr-row-find">
          <div class="fr-input-wrap">
            <input id="findInput" class="fr-input" type="text" placeholder="Find" aria-label="Find">
            <div class="fr-inline-toggles">
              <button id="findCaseToggle" class="fr-toggle-btn" type="button" aria-label="Match Case" aria-pressed="false" title="Match Case">Aa</button>
              <button id="findWordToggle" class="fr-toggle-btn" type="button" aria-label="Match Whole Word" aria-pressed="false" title="Match Whole Word">ab</button>
              <button id="findRegexToggle" class="fr-toggle-btn" type="button" aria-label="Use Regular Expression" aria-pressed="false" title="Use Regular Expression">.*</button>
            </div>
          </div>
          <div id="findStatus" class="fr-status">No results</div>
          <div class="fr-divider" aria-hidden="true"></div>
          <button id="findPrev" class="fr-icon-btn" type="button" aria-label="Previous Match" title="Previous Match" disabled>↑</button>
          <button id="findNext" class="fr-icon-btn" type="button" aria-label="Next Match" title="Next Match" disabled>↓</button>
          <button id="findClose" class="fr-icon-btn fr-close-btn" type="button" aria-label="Close Find and Replace" title="Close">✕</button>
        </div>
        <div class="fr-row fr-row-replace">
          <div class="fr-input-wrap">
            <input id="replaceInput" class="fr-input" type="text" placeholder="Replace" aria-label="Replace">
            <div class="fr-inline-toggles">
              <button id="replaceCaseToggle" class="fr-toggle-btn" type="button" aria-label="Preserve Case" aria-pressed="false" title="Preserve Case">AB</button>
            </div>
          </div>
          <div class="fr-actions">
            <button id="replaceOne" class="fr-action-btn" type="button" aria-label="Replace" title="Replace" disabled>↵</button>
            <button id="replaceAll" class="fr-action-btn" type="button" aria-label="Replace All" title="Replace All" disabled>⇅</button>
          </div>
        </div>
        <div id="findOverflowMenu" class="fr-overflow-menu" role="menu" aria-label="Find Options">
          <button id="findOverflowSelection" class="fr-overflow-item" type="button" role="menuitem">Find in selection</button>
          <button id="findOverflowDiacritics" class="fr-overflow-item" type="button" role="menuitem">Match diacritics</button>
          <button id="findOverflowPreserveCase" class="fr-overflow-item" type="button" role="menuitem">Toggle preserve case</button>
        </div>
      </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private generateTableHtml(addSerialIndex: boolean): string {
    const visibleColumns = this.getVisibleColumns();
    const currentLocale = parseResxFilename(path.basename(this.document.uri.fsPath)).locale ?? null;
    const isDefaultFile = currentLocale === null;
    // In single mode, lock name and default locale columns unless the open file IS the default
    const lockNameAndDefault = this.viewMode === 'single' && !isDefaultFile;
    let html = '<table>';

    // Header row
    html += '<thead><tr>';
    for (const vc of visibleColumns) {
      const physIdx = vc.physicalIndex;
      if (vc.kind === 'index') {
        if (addSerialIndex) {
          html += `<th class="index-col" data-col="${physIdx}">#</th>`;
        } else {
          html += `<th class="index-col" style="display:none;" data-col="${physIdx}"></th>`;
        }
      } else if (vc.kind === 'name') {
        html += `<th class="name-col" data-col="${physIdx}"${lockNameAndDefault ? ' data-readonly' : ''}>${this.escapeHtml(vc.label)}</th>`;
      } else if (vc.kind === 'comment') {
        html += `<th class="comment-col" data-col="${physIdx}">${this.escapeHtml(vc.label)}</th>`;
      } else if (vc.kind === 'locale') {
        html += `<th class="locale-header value-col" data-col="${physIdx}"${(lockNameAndDefault && vc.locale === null) ? ' data-readonly' : ''}>${this.escapeHtml(vc.label)}</th>`;
      }
    }
    html += '</tr></thead>';

    // Helper: build a safe data-vscode-context attribute value
    const ctx = (obj: Record<string, unknown>) =>
      ` data-vscode-context="${JSON.stringify(obj).replace(/"/g, '&quot;')}"`;

    // Body rows
    html += '<tbody>';
    for (let r = 0; r < this.gridRows.length; r++) {
      const row = this.gridRows[r];
      html += `<tr${ctx({ webviewSection: 'resxrow', name: row.name })}>`;

      for (const vc of visibleColumns) {
        const physIdx = vc.physicalIndex;
        if (vc.kind === 'index') {
          if (addSerialIndex) {
            html += `<td class="index-col" data-row="${r}" data-col="${physIdx}">${r + 1}</td>`;
          } else {
            html += `<td class="index-col" style="display:none;" data-row="${r}" data-col="${physIdx}"></td>`;
          }
        } else if (vc.kind === 'name') {
          html += `<td class="name-col" data-row="${r}" data-col="${physIdx}"${lockNameAndDefault ? ' data-readonly' : ''}}>${this.escapeHtml(row.name)}</td>`;
        } else if (vc.kind === 'comment') {
          html += `<td class="comment-col" data-row="${r}" data-col="${physIdx}">${this.escapeHtml(row.comment)}</td>`;
        } else if (vc.kind === 'locale') {
          const value = row.values.get(vc.locale) ?? '';
          const valueSafe = this.escapeHtml(value);
          const missingClass = this.getMissingCellStyle(r, vc);
          const titleAttr = (value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0)
            ? ` title="${this.escapeHtml(value)}"` : '';
          html += `<td class="value-col${missingClass}" data-row="${r}" data-col="${physIdx}"${titleAttr}${lockNameAndDefault && vc.locale === null ? " data-readonly" : ""}>${valueSafe}</td>`;
        }
      }

      html += '</tr>';
    }

    html += '</tbody></table>';
    return html;
  }

  // ── Utilities ────────────────────────────────────────────────────

  private escapeCss(text: string): string {
    return text.replace(/[\\"]/g, m => (m === '\\' ? '\\\\' : '\\"'));
  }

  private escapeAttr(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  // Expose for tests
  public __test = {
    getColumns: () => this.columns,
    getGridRows: () => this.gridRows,
    getLocaleSet: () => this.localeSet,
  };
}

// ─────────────────────────────────────────────────────────────────────
// ResxEditorProvider — VS Code CustomTextEditorProvider wrapper.
// ─────────────────────────────────────────────────────────────────────

export class ResxEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'resx.editor';
  public static editors: ResxEditorController[] = [];
  public static currentActive: ResxEditorController | undefined;
  public static readonly serialKey = 'resx.serialIndexByUri';

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    console.log(`RESX(reg): creating controller for ${document.uri.toString()}`);
    const controller = new ResxEditorController(this.context);

    webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        ResxEditorProvider.currentActive = controller;
      }
    });

    await controller.resolveCustomTextEditor(document, webviewPanel, token);
  }

  public static getActiveProvider(): ResxEditorController | undefined {
    return ResxEditorProvider.currentActive || ResxEditorProvider.editors.find(ed => ed.isActive());
  }

  public static getSerialIndexForUri(context: vscode.ExtensionContext, uri: vscode.Uri): boolean {
    const map = context.workspaceState.get<Record<string, boolean>>(ResxEditorProvider.serialKey, {});
    return map[uri.toString()] ?? true;
  }

  public static async setSerialIndexForUri(context: vscode.ExtensionContext, uri: vscode.Uri, val: boolean): Promise<void> {
    const map = { ...(context.workspaceState.get<Record<string, boolean>>(ResxEditorProvider.serialKey, {})) };
    map[uri.toString()] = !!val;
    await context.workspaceState.update(ResxEditorProvider.serialKey, map);
  }
}
