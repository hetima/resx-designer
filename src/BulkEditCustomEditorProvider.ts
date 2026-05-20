import * as vscode from 'vscode';
import * as path from 'path';
import {
  ResxLocaleSet, BulkEditWebviewMessage, BulkEditTempFileMetadata
} from './types/resx';
import { findRelatedResxFiles, getSortedLocales } from './resx-locale-finder';
import { serializeResx } from './resx-writer';
import { getThemeCssVariables } from './theme-colors';

// ─────────────────────────────────────────────────────────────────────
// BulkEditController — manages one bulk-edit webview + its state
// ─────────────────────────────────────────────────────────────────────

class BulkEditController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly webviewPanel: vscode.WebviewPanel;
  private readonly metadata: BulkEditTempFileMetadata;
  private localeSet: ResxLocaleSet | null = null;
  /** Pending edits: locale → value (in-memory only) */
  private pendingEdits = new Map<string | null, string>();
  private originalValues = new Map<string | null, string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    webviewPanel: vscode.WebviewPanel,
    metadata: BulkEditTempFileMetadata,
    private readonly fireDirty: () => void,
    private readonly documentUri: vscode.Uri
  ) {
    this.webviewPanel = webviewPanel;
    this.metadata = metadata;

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'media'))
      ]
    };

    webviewPanel.webview.onDidReceiveMessage(
      msg => this.handleMessage(msg as BulkEditWebviewMessage),
      null,
      this.disposables
    );

    webviewPanel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Initialize: load locale set and render webview. Call once after construction. */
  async init(): Promise<void> {
    try {
      this.localeSet = await findRelatedResxFiles(vscode.Uri.parse(this.metadata.sourceUri));
    } catch (err) {
      console.error('[bulkEdit] failed to load locale set', err);
    }

    if (!this.localeSet) {
      vscode.window.showErrorMessage(
        `RESX Bulk Edit: Could not find related locale files for "${this.metadata.sourceUri}".`
      );
      return;
    }

    this.storeOriginalValues();
    this.webviewPanel.webview.html = this.buildHtml();
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
    this.disposables.length = 0;
  }

  // ── Data ─────────────────────────────────────────────────────────

  private storeOriginalValues(): void {
    this.originalValues.clear();
    if (!this.localeSet) { return; }
    for (const [locale, doc] of this.localeSet.locales) {
      const entry = doc.entries.find(e => e.name === this.metadata.keyName);
      this.originalValues.set(locale, entry?.value ?? '');
    }
  }

  private getCurrentValues(): Array<{ locale: string | null; label: string; value: string }> {
    if (!this.localeSet) { return []; }
    const sortedLocales = getSortedLocales(this.localeSet, null);
    return sortedLocales.map(loc => {
      const edited = this.pendingEdits.get(loc);
      if (edited !== undefined) {
        return { locale: loc, label: loc ?? '(default)', value: edited };
      }
      const doc = this.localeSet!.locales.get(loc)!;
      const entry = doc.entries.find(e => e.name === this.metadata.keyName);
      return { locale: loc, label: loc ?? '(default)', value: entry?.value ?? '' };
    });
  }

  private async reloadLocaleSet(): Promise<void> {
    try {
      this.localeSet = await findRelatedResxFiles(vscode.Uri.parse(this.metadata.sourceUri));
    } catch (err) {
      console.error('[bulkEdit] failed to reload locale set', err);
    }
  }

  // ── Message Handling ─────────────────────────────────────────────

  private handleMessage(msg: BulkEditWebviewMessage): void {
    if (msg.type === 'cellChanged') {
      const prev = this.pendingEdits.get(msg.locale ?? null);
      this.pendingEdits.set(msg.locale ?? null, msg.value);
      if (prev === undefined) {
        // First edit for this locale — fire dirty
        this.fireDirty();
      }
    }
  }

  // ── Save / Revert (called by the provider) ───────────────────────

  async save(): Promise<void> {
    if (!this.localeSet || this.pendingEdits.size === 0) { return; }

    for (const [locale, value] of this.pendingEdits) {
      const doc = this.localeSet.locales.get(locale);
      if (!doc) { continue; }
      const entry = doc.entries.find(e => e.name === this.metadata.keyName);
      if (entry) {
        entry.value = value;
      } else {
        doc.entries.push({ name: this.metadata.keyName, value, comment: '' });
      }
      const xml = serializeResx(doc);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(doc.path),
        new TextEncoder().encode(xml)
      );
    }

    this.pendingEdits.clear();
    await this.reloadLocaleSet();
    this.storeOriginalValues();

    // Notify webview that save completed
    const values = this.getCurrentValues();
    this.webviewPanel.webview.postMessage({
      type: 'saved',
      localeData: values.map(v => ({ locale: v.locale, value: v.value }))
    });

    vscode.window.showInformationMessage(
      `RESX: Saved "${this.metadata.keyName}" to all locale files.`
    );
  }

  async revert(): Promise<void> {
    this.pendingEdits.clear();
    await this.reloadLocaleSet();
    this.storeOriginalValues();
    const values = this.getCurrentValues();
    this.webviewPanel.webview.postMessage({
      type: 'reverted',
      localeData: values.map(v => ({ locale: v.locale, value: v.value }))
    });
  }

  get hasPendingEdits(): boolean {
    return this.pendingEdits.size > 0;
  }

  getPendingEdits(): Map<string | null, string> {
    return this.pendingEdits;
  }

  // ── Webview HTML ────────────────────────────────────────────────

  private buildHtml(): string {
    const config = vscode.workspace.getConfiguration('resx');
    const fontFamily = config.get<string>('fontFamily', '');
    const fontSize = config.get<number>('fontSize', 0);
    const cellPadding = config.get<number>('cellPadding', 4);
    const themeVars = getThemeCssVariables();

    const fontStr = fontFamily
      ? `${fontFamily}, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif`
      : "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
    const fontSizeStr = fontSize > 0 ? `${fontSize}px` : 'inherit';

    const localeData = this.getCurrentValues();
    const localeJson = JSON.stringify(
      localeData.map(v => ({ locale: v.locale, value: v.value }))
    );

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${this.webviewPanel.webview.cspSource};">
  <style>
    :root {
      ${themeVars}    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ${fontStr};
      font-size: ${fontSizeStr};
      background: var(--resx-body);
      color: var(--resx-fg);
      padding: 16px;
    }
    h2 {
      font-size: 1.2em;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--resx-fg);
    }
    h2 .name {
      font-family: Consolas, 'Courier New', monospace;
    }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    th, td {
      padding: ${cellPadding}px 12px;
      border: 1px solid var(--resx-border);
      font-size: inherit;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--resx-header-bg);
      text-align: left;
      font-weight: 600;
      user-select: none;
      z-index: 1;
    }
    th.locale-col { width: 120px; }
    td.locale-col {
      background: var(--resx-header-bg);
      font-weight: 500;
      user-select: none;
    }
    td.value-col {
      outline: none;
      min-height: 1.4em;
      cursor: text;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      overflow: auto;
      max-height: 200px;
    }
    td.value-col:focus {
      outline: 2px solid var(--resx-focus-border);
      outline-offset: -2px;
    }
    td.value-col.missing {
      background: var(--resx-missing-bg);
    }
    td.value-col.empty {
      opacity: 0.5;
    }
  </style>
</head>
<body>
  <h2><span class="name">${this.escapeHtml(this.metadata.keyName)}</span></h2>
  <table>
    <thead>
      <tr>
        <th class="locale-col">Locale</th>
        <th>Value</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let localeData = ${localeJson};
    const tbody = document.getElementById('rows');

    function escapeHtml(text) {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderRows(data) {
      tbody.innerHTML = '';
      data.forEach((item, idx) => {
        const tr = document.createElement('tr');
        const tdLocale = document.createElement('td');
        tdLocale.className = 'locale-col';
        tdLocale.textContent = item.locale === null ? '(default)' : item.locale;
        tr.appendChild(tdLocale);

        const tdValue = document.createElement('td');
        tdValue.className = 'value-col' + (item.value === '' ? ' empty missing' : '');
        tdValue.dataset.idx = idx;
        tdValue.dataset.locale = item.locale === null ? '' : item.locale;
        tdValue.contentEditable = 'true';
        tdValue.textContent = item.value;
        tdValue.title = item.value.indexOf('\\n') >= 0 || item.value.indexOf('\\r') >= 0 ? item.value : '';
        tr.appendChild(tdValue);

        tbody.appendChild(tr);
      });
    }

    renderRows(localeData);

    // Listen for edits
    tbody.addEventListener('input', (e) => {
      const cell = e.target.closest('td.value-col');
      if (!cell) return;
      const idx = parseInt(cell.dataset.idx, 10);
      const locale = cell.dataset.locale || null;
      const value = cell.textContent || '';
      cell.classList.toggle('empty', value === '');
      cell.classList.toggle('missing', value === '');
      localeData[idx].value = value;
      vscode.postMessage({ type: 'cellChanged', locale, value });
    });

    tbody.addEventListener('focusout', (e) => {
      const cell = e.target.closest('td.value-col');
      if (!cell) return;
      const value = cell.textContent || '';
      cell.title = (value.indexOf('\\n') >= 0 || value.indexOf('\\r') >= 0) ? value : '';
    });

    // Keyboard navigation
    tbody.addEventListener('keydown', (e) => {
      const cell = e.target.closest('td.value-col');
      if (!cell) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const next = cell.closest('tr').nextElementSibling?.querySelector('td.value-col');
        if (next) next.focus();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const target = e.shiftKey
          ? cell.closest('tr').previousElementSibling?.querySelector('td.value-col')
          : cell.closest('tr').nextElementSibling?.querySelector('td.value-col');
        if (target) target.focus();
        return;
      }
      if (e.key === 'Escape') {
        // Revert this cell to the last committed value, then blur
        const idx = parseInt(cell.dataset.idx, 10);
        cell.textContent = localeData[idx].value;
        cell.classList.toggle('empty', localeData[idx].value === '');
        cell.classList.toggle('missing', localeData[idx].value === '');
        cell.blur();
        return;
      }
    });

    // Listen for host messages (save/revert completed)
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'saved' || msg.type === 'reverted') {
        localeData = msg.localeData;
        renderRows(localeData);
      }
    });
  </script>
</body>
</html>`;
  }

  // ── Utilities ────────────────────────────────────────────────────

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}

// ─────────────────────────────────────────────────────────────────────
// BulkEditCustomDocument — document model for the custom editor
// ─────────────────────────────────────────────────────────────────────

export class BulkEditCustomDocument implements vscode.CustomDocument {

  readonly uri: vscode.Uri;
  readonly metadata: BulkEditTempFileMetadata;

  private _controller: BulkEditController | null = null;

  constructor(uri: vscode.Uri, metadata: BulkEditTempFileMetadata) {
    this.uri = uri;
    this.metadata = metadata;
  }

  get controller(): BulkEditController { return this._controller!; }
  setController(c: BulkEditController): void { this._controller = c; }

  dispose(): void {
    // Mark as closed so crash recovery skips it
    this.writeClosedFlag();
    this._controller?.dispose();
    this._controller = null;
  }

  /** Write { closed: true } to the temp file so crash recovery can skip it. */
  private writeClosedFlag(): void {
    const data: BulkEditTempFileMetadata = { ...this.metadata, closed: true };
    vscode.workspace.fs.writeFile(
      this.uri,
      new TextEncoder().encode(JSON.stringify(data, null, 2))
    ).then(undefined, err => {
      console.warn('[bulkEdit] failed to write closed flag', err);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// BulkEditCustomEditorProvider — CustomEditorProvider implementation
// ─────────────────────────────────────────────────────────────────────

export class BulkEditCustomEditorProvider implements vscode.CustomEditorProvider<BulkEditCustomDocument> {

  public static readonly viewType = 'resx.bulkEdit';

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<BulkEditCustomDocument>
  >();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  private readonly extensionContext: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.extensionContext = context;
  }

  // ── CustomEditorProvider lifecycle ───────────────────────────────

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<BulkEditCustomDocument> {
    let metadata: BulkEditTempFileMetadata;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      metadata = JSON.parse(new TextDecoder().decode(bytes)) as BulkEditTempFileMetadata;
    } catch {
      throw new Error(`RESX Bulk Edit: Cannot read temp file "${uri.fsPath}".`);
    }
    if (!metadata.sourceUri || !metadata.keyName) {
      throw new Error(`RESX Bulk Edit: Invalid metadata in "${uri.fsPath}".`);
    }
    return new BulkEditCustomDocument(uri, metadata);
  }

  async resolveCustomEditor(
    document: BulkEditCustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const controller = new BulkEditController(
      this.extensionContext,
      webviewPanel,
      document.metadata,
      () => this._onDidChangeCustomDocument.fire({ document }),
      document.uri
    );
    document.setController(controller);
    await controller.init();
  }

  // ── Save / Revert / Backup ───────────────────────────────────────

  async saveCustomDocument(
    document: BulkEditCustomDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await document.controller.save();
  }

  async saveCustomDocumentAs(
    document: BulkEditCustomDocument,
    _destination: vscode.Uri,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    // "Save As" is redirected to normal save (temp file semantics)
    await document.controller.save();
  }

  async revertCustomDocument(
    document: BulkEditCustomDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await document.controller.revert();
  }

  async backupCustomDocument(
    document: BulkEditCustomDocument,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    // Write metadata + pending edits to backup
    const pendingObj: Record<string, string> = {};
    if (document.controller.hasPendingEdits) {
      for (const [k, v] of document.controller.getPendingEdits()) {
        pendingObj[k === null ? '__null__' : k] = v;
      }
    }
    const backupData = { metadata: document.metadata, pendingEdits: pendingObj };
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
    const dir = vscode.Uri.file(path.join(context.globalStorageUri.fsPath, 'bulk-edit'));
    try { await vscode.workspace.fs.createDirectory(dir); } catch { /* already exists */ }
    return dir;
  }

  public static async createTempFile(
    context: vscode.ExtensionContext,
    sourceUri: vscode.Uri,
    keyName: string
  ): Promise<vscode.Uri> {
    const dir = await BulkEditCustomEditorProvider.ensureTempDir(context);
    const fileName = `[Bulk] ${keyName}.resxbulk`;
    const tmpUri = vscode.Uri.file(path.join(dir.fsPath, fileName));
    const metadata: BulkEditTempFileMetadata = {
      sourceUri: sourceUri.toString(),
      keyName
    };

    // If existing temp file has closed flag, it's safe to reuse (just overwrite)
    // Otherwise delete and create fresh
    try {
      const existingBytes = await vscode.workspace.fs.readFile(tmpUri);
      const existingMeta = JSON.parse(new TextDecoder().decode(existingBytes)) as BulkEditTempFileMetadata;
      if (existingMeta.closed) {
        // Reuse: just overwrite with fresh metadata (no closed flag)
        await vscode.workspace.fs.writeFile(
          tmpUri,
          new TextEncoder().encode(JSON.stringify(metadata, null, 2))
        );
        return tmpUri;
      }
    } catch { /* not found or corrupt — fall through to fresh create */ }

    // Delete existing if present (unclosed crash remnant or same key)
    try { await vscode.workspace.fs.delete(tmpUri); } catch { /* not found */ }
    await vscode.workspace.fs.writeFile(
      tmpUri,
      new TextEncoder().encode(JSON.stringify(metadata, null, 2))
    );
    return tmpUri;
  }

  public static async scanOrphanedFiles(
    context: vscode.ExtensionContext
  ): Promise<Array<{ uri: vscode.Uri; metadata: BulkEditTempFileMetadata }>> {
    // Only return unclosed files (potential crash remnants)
    const all = await BulkEditCustomEditorProvider.scanAllTempFiles(context);
    return all.filter(item => !item.metadata.closed);
  }

  /** Scan all .resxbulk temp files including closed ones. */
  public static async scanAllTempFiles(
    context: vscode.ExtensionContext
  ): Promise<Array<{ uri: vscode.Uri; metadata: BulkEditTempFileMetadata }>> {
    const dir = await BulkEditCustomEditorProvider.ensureTempDir(context);
    const results: Array<{ uri: vscode.Uri; metadata: BulkEditTempFileMetadata }> = [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.resxbulk')) { continue; }
        const uri = vscode.Uri.file(path.join(dir.fsPath, name));
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const text = new TextDecoder().decode(bytes);
          const metadata = JSON.parse(text) as BulkEditTempFileMetadata;
          if (metadata.sourceUri && metadata.keyName) {
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
