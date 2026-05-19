import * as vscode from 'vscode';
import * as path from 'path';
import {
  ResxLocaleSet, ResxGridColumn, ResxGridRow,
  ResxDocument, ResxEntry, WebviewToHostMessage
} from './types/resx';
import { parseResx, encodeXmlEntities } from './resx-parser';
import { serializeResx } from './resx-writer';
import { findRelatedResxFiles, getSortedLocales, parseResxFilename } from './resx-locale-finder';

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
  private fileWatchers: vscode.FileSystemWatcher[] = [];
  private highlightMissing = true;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.document = document;
    this.currentWebviewPanel = webviewPanel;
    ResxEditorProvider.editors.push(this);

    const config = vscode.workspace.getConfiguration('resx', this.document.uri);
    if (!config.get<boolean>('enabled', true)) {
      await this.openWithDefaultEditorAndClose(webviewPanel);
      return;
    }

    this.highlightMissing = config.get<boolean>('highlightMissingTranslations', true);

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

    webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        ResxEditorProvider.currentActive = this;
      }
      this.updateWebviewContent();
    });

    // Handle messages from the webview
    webviewPanel.webview.onDidReceiveMessage(async (e: WebviewToHostMessage) => {
      await this.handleWebviewMessage(e);
    });

    // Watch for changes to the current document made outside our editor
    const changeSub = vscode.workspace.onDidChangeTextDocument(ev => {
      if (
        ev.document.uri.toString() === document.uri.toString() &&
        !this.isUpdating
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

    webviewPanel.webview.postMessage({ type: 'focus' });
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

    const sortedLocales = getSortedLocales(this.localeSet);

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
        // Update comment across all locale files
        await this.updateCommentAcrossAllLocales(this.gridRows[row].name, value);
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

  private async handleInsertRow(index: number): Promise<void> {
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

  private async handleDeleteRows(indices: number[]): Promise<void> {
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

  private handleSortRows(ascending: boolean): void {
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
      await this.handleEditCell(repl.row, repl.col, repl.value);
    }

    this.currentWebviewPanel?.webview.postMessage({
      type: 'replaceMatchesResult', requestId
    });
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
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(xml));
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
    if (!this.highlightMissing || column.kind !== 'locale') { return ''; }
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
    const addSerialIndex = config.get<boolean>('showSerialIndex', true);

    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;

    // Generate table HTML
    const tableHtml = this.generateTableHtml(isDark, addSerialIndex);

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
      body { font-family: ${this.escapeCss(fontFamily)}; font-size: ${fontSize}px; margin: 0; padding: 0; user-select: none; }
      .table-container { overflow: auto; height: 100vh; }
      table { border-collapse: collapse; width: max-content; }
      th, td { padding: ${cellPadding}px 8px; border: 1px solid ${isDark ? '#555' : '#ccc'}; font-size: inherit; }
      th { position: sticky; top: 0; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; z-index: 10; }
      td { overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; }
      td.selected, th.selected { background-color: ${isDark ? '#333333' : '#cce0ff'} !important; }
      td.editing, th.editing { overflow: visible !important; white-space: pre-wrap !important; overflow-wrap: anywhere !important; max-width: none !important; }
      .highlight { background-color: ${isDark ? '#2a2a2a' : '#fefefe'} !important; }
      .active-match { background-color: ${isDark ? '#444444' : '#ffffcc'} !important; }
      .csv-link { color: ${isDark ? '#6cb6ff' : '#0066cc'}; text-decoration: underline; cursor: pointer; }
      .csv-link:hover { color: ${isDark ? '#8ecfff' : '#0044aa'}; }
      td.missing-translation { background-color: ${isDark ? '#3a2a2a' : '#fff3e0'} !important; }
      td.missing-translation.selected { background-color: ${isDark ? '#4a3a3a' : '#ffe0b2'} !important; }
      .locale-header { cursor: default; }
      .name-col { min-width: 20ch; }
      .value-col { min-width: 25ch; }
      .index-col { min-width: 3ch; max-width: 6ch; color: #888; text-align: right; }
      .comment-col { min-width: 15ch; }
      #findReplaceWidget {
        position: fixed; top: 12px; right: 20px; width: 592px; min-width: 592px; max-width: 592px;
        background: #171717; border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px;
        box-shadow: 0 6px 18px rgba(0,0,0,0.45); z-index: 1200; display: none; align-items: stretch;
        color: #d4d4d4; font-family: ${this.escapeCss(fontFamily)}; font-size: inherit;
      }
      #findReplaceWidget.open { display: flex; }
      #findReplaceWidget .fr-gutter { width: 24px; min-width: 24px; border-radius: 6px; background: #2a2b2b; border-right: 1px solid #1f1f1f; margin-right: 10px; display: flex; align-items: center; justify-content: center; }
      #findReplaceWidget .fr-content { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
      #findReplaceWidget.replace-collapsed .fr-row-replace { display: none; }
      #findReplaceWidget .fr-row { display: flex; align-items: center; gap: 8px; }
      #findReplaceWidget .fr-row-find .fr-input-wrap { flex: 0 0 calc(25ch + 118px); width: calc(25ch + 118px); }
      #findReplaceWidget .fr-row-replace .fr-input-wrap { flex: 0 0 calc(25ch + 54px); width: calc(25ch + 54px); }
      #findReplaceWidget .fr-input-wrap { position: relative; flex: 1 1 auto; min-width: 0; }
      #findReplaceWidget .fr-input { width: 100%; height: 36px; box-sizing: border-box; border: 1px solid #2a2a2a; border-radius: 6px; background: #1c1c1c; color: #d4d4d4; padding-left: 10px; font-size: inherit; outline: none; }
      #findReplaceWidget .fr-input::placeholder { color: #6a6a6a; }
      #findReplaceWidget .fr-input:focus { border-color: #3a3a3a; box-shadow: 0 0 0 2px rgba(255,255,255,0.06); }
      #findInput { padding-right: 118px; }
      #replaceInput { padding-right: 54px; }
      #findReplaceWidget .fr-inline-toggles { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 4px; padding-left: 6px; border-left: 1px solid rgba(42,42,42,0.75); }
      #findReplaceWidget .fr-toggle-btn { min-width: 24px; height: 24px; border: 0; border-radius: 4px; background: transparent; color: rgba(189,189,189,0.8); font-size: 0.86em; cursor: pointer; padding: 0 4px; }
      #findReplaceWidget .fr-toggle-btn:hover { background: rgba(255,255,255,0.04); color: #e6e6e6; }
      #findReplaceWidget .fr-toggle-btn[aria-pressed="true"] { color: #e6e6e6; box-shadow: inset 0 -2px 0 #e6e6e6; }
      #findReplaceWidget .fr-status { min-width: 84px; text-align: right; color: #d0d0d0; font-size: inherit; }
      #findReplaceWidget .fr-divider { width: 1px; height: 22px; background: #2a2a2a; }
      #findReplaceWidget .fr-icon-btn, #findReplaceWidget .fr-action-btn, #findReplaceWidget .fr-caret-btn { width: 28px; height: 28px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: #bdbdbd; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0; }
      #findReplaceWidget .fr-icon-btn:hover, #findReplaceWidget .fr-action-btn:hover, #findReplaceWidget .fr-caret-btn:hover { background: rgba(255,255,255,0.05); color: #e6e6e6; }
      #findReplaceWidget .fr-icon-btn[disabled], #findReplaceWidget .fr-action-btn[disabled] { color: #6a6a6a; cursor: default; pointer-events: none; }
      #findReplaceWidget .fr-close-btn:hover { background: rgba(255,255,255,0.08); color: #ffffff; }
      #findReplaceWidget .fr-actions { display: flex; align-items: center; gap: 8px; }
      #findReplaceWidget .fr-overflow-menu { position: absolute; top: 48px; right: 44px; min-width: 200px; background: #202020; border: 1px solid #2f2f2f; border-radius: 6px; box-shadow: 0 10px 24px rgba(0,0,0,0.45); padding: 4px; display: none; }
      #findReplaceWidget .fr-overflow-menu.open { display: block; }
      #findReplaceWidget .fr-overflow-item { width: 100%; border: 0; background: transparent; color: #d4d4d4; border-radius: 4px; text-align: left; padding: 6px 8px; cursor: pointer; font-size: inherit; }
      #findReplaceWidget .fr-overflow-item:hover { background: rgba(255,255,255,0.05); }
      #contextMenu { position: absolute; display: none; background: ${isDark ? '#2d2d2d' : '#ffffff'}; border: 1px solid ${isDark ? '#555' : '#ccc'}; z-index: 10000; font-family: ${this.escapeCss(fontFamily)}; font-size: inherit; }
      #contextMenu div { padding: 4px 12px; cursor: pointer; }
      #contextMenu div:hover { background: ${isDark ? '#3d3d3d' : '#eeeeee'}; }
    </style>
  </head>
  <body>
    <div id="csv-root" class="table-container"
         data-resx="1"
         data-defaultvalues="${this.escapeAttr(defaultValues)}"
         data-defaultlocale="${defaultLocaleExists ? '1' : '0'}"
         data-fontsize="${fontSize}"
         data-wheelzoomenabled="${mouseWheelZoomEnabled ? '1' : '0'}"
         data-wheelzoominvert="${mouseWheelZoomInvert ? '1' : '0'}"
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
          <button id="findMenuButton" class="fr-icon-btn" type="button" aria-label="More Find Options" title="More Find Options">☰</button>
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
    <div id="contextMenu"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private generateTableHtml(isDark: boolean, addSerialIndex: boolean): string {
    let html = '<table>';

    // Header row
    html += '<thead><tr>';
    let colIdx = 0;
    if (addSerialIndex) {
      html += `<th class="index-col" data-col="${colIdx}">#</th>`;
      colIdx++;
    } else {
      // Still occupy col 0 even if hidden — we just skip serial index in columns
      html += `<th class="index-col" style="display:none;" data-col="${colIdx}"></th>`;
      colIdx++;
    }
    html += `<th class="name-col" data-col="${colIdx}">Name</th>`;
    colIdx++;
    html += `<th class="comment-col" data-col="${colIdx}">Comment</th>`;
    colIdx++;
    for (let i = 3; i < this.columns.length; i++) {
      const c = this.columns[i];
      html += `<th class="locale-header value-col" data-col="${i}">${this.escapeHtml(c.label)}</th>`;
    }
    html += '</tr></thead>';

    // Body rows
    html += '<tbody>';
    for (let r = 0; r < this.gridRows.length; r++) {
      const row = this.gridRows[r];
      html += '<tr>';

      let c = 0;
      // Serial index
      if (addSerialIndex) {
        html += `<td class="index-col" data-row="${r}" data-col="${c}">${r + 1}</td>`;
      } else {
        html += `<td class="index-col" style="display:none;" data-row="${r}" data-col="${c}"></td>`;
      }
      c++;
      // Name
      const nameSafe = this.escapeHtml(row.name);
      html += `<td class="name-col" data-row="${r}" data-col="${c}">${nameSafe}</td>`;
      c++;
      // Comment
      const commentSafe = this.escapeHtml(row.comment);
      html += `<td class="comment-col" data-row="${r}" data-col="${c}">${commentSafe}</td>`;
      c++;
      // Locale values
      for (let i = 3; i < this.columns.length; i++) {
        const col = this.columns[i];
        const value = row.values.get(col.locale) ?? '';
        const valueSafe = this.escapeHtml(value);
        const missingClass = this.getMissingCellStyle(r, col);
        const titleAttr = (value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0)
          ? ` title="${this.escapeHtml(value)}"` : '';
        html += `<td class="value-col${missingClass}" data-row="${r}" data-col="${i}"${titleAttr}>${valueSafe}</td>`;
      }

      html += '</tr>';
    }

    // Virtual empty row for quick append
    const vRow = this.gridRows.length;
    if (addSerialIndex) {
      html += `<td class="index-col" data-row="${vRow}" data-col="0">${this.gridRows.length + 1}</td>`;
    } else {
      html += `<td style="display:none;" data-row="${vRow}" data-col="0"></td>`;
    }
    html += `<td class="name-col" data-row="${vRow}" data-col="1"></td>`;
    html += `<td class="comment-col" data-row="${vRow}" data-col="2"></td>`;
    for (let i = 3; i < this.columns.length; i++) {
      html += `<td class="value-col" data-row="${vRow}" data-col="${i}"></td>`;
    }
    html += '</tr>';

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
