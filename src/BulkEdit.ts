import * as vscode from 'vscode';
import * as path from 'path';
import { TableEditProvider } from './table-edit';
import {
  ResxLocaleSet, BulkEditTempFileMetadata
} from './types/resx';
import { findRelatedResxFiles, getSortedLocales } from './resx-locale-finder';
import { serializeResx } from './resx-writer';

// ─────────────────────────────────────────────────────────────────────
// BulkEditCustomDocument — document model for the custom editor
// ─────────────────────────────────────────────────────────────────────

export class BulkEditCustomDocument implements vscode.CustomDocument {

  readonly uri: vscode.Uri;
  readonly metadata: BulkEditTempFileMetadata;
  /** Pending edits restored from backup (hot-exit). Consumed by resolveCustomEditor. */
  pendingEditsFromBackup: Map<string | null, string> | null = null;

  private _provider: BulkEditProvider | null = null;

  constructor(uri: vscode.Uri, metadata: BulkEditTempFileMetadata) {
    this.uri = uri;
    this.metadata = metadata;
  }

  setProvider(p: BulkEditProvider): void { this._provider = p; }
  get provider(): BulkEditProvider | null { return this._provider; }

  dispose(): void {
    this.writeClosedFlag();
    this._provider?.dispose();
    this._provider = null;
  }

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
// BulkEditProvider — extends TableEditProvider + CustomEditorProvider
// ─────────────────────────────────────────────────────────────────────

export class BulkEditProvider extends TableEditProvider implements vscode.CustomEditorProvider<BulkEditCustomDocument> {

  public static readonly viewType = 'resx.bulkEdit';

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<BulkEditCustomDocument>
  >();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  private readonly _context: vscode.ExtensionContext;
  /** Per-document state: localeSet, pendingEdits, originalValues. */
  private readonly _docState = new Map<BulkEditCustomDocument, {
    localeSet: ResxLocaleSet | null;
    pendingEdits: Map<string | null, string>;
    originalValues: Map<string | null, string>;
  }>();

  constructor(context: vscode.ExtensionContext) {
    super({
      onDirtyChange: () => { /* fires per-active document via _handleMessage override */ },
    });
    this._context = context;
  }

  // ── Helpers ───────────────────────────────────────────────────

  private fireDirty(document: BulkEditCustomDocument): void {
    this._onDidChangeCustomDocument.fire({ document });
  }

  private getDocState(document: BulkEditCustomDocument) {
    return this._docState.get(document);
  }

  private storeOriginalValues(document: BulkEditCustomDocument): void {
    const st = this.getDocState(document);
    if (!st) { return; }
    st.originalValues.clear();
    if (!st.localeSet) { return; }
    for (const [locale, doc] of st.localeSet.locales) {
      const entry = doc.entries.find(e => e.name === document.metadata.keyName);
      st.originalValues.set(locale, entry?.value ?? '');
    }
  }

  private async reloadLocaleSet(document: BulkEditCustomDocument): Promise<void> {
    const st = this.getDocState(document);
    if (!st) { return; }
    try {
      st.localeSet = await findRelatedResxFiles(vscode.Uri.parse(document.metadata.sourceUri));
    } catch (err) {
      console.error('[bulkEdit] failed to reload locale set', err);
    }
  }

  /** Build columns/rows for TableEditProvider.buildHtml() from localeSet + pendingEdits. */
  private buildTableData(document: BulkEditCustomDocument): {
    columns: any[];
    rows: any[];
  } {
    const st = this.getDocState(document);
    if (!st || !st.localeSet) {
      return { columns: [], rows: [] };
    }

    const sortedLocales = getSortedLocales(st.localeSet, null);

    // 2 fixed columns: Locale (read-only) + Value (editable)
    const columns = [
      {
        kind: "index" as const,
        locale: null,
        label: "#",
        editable: false,
        resizable: false,
        width: "auto",
      },
      {
        kind: "locale" as const,
        locale: "__localeLabel__",
        label: "Locale",
        editable: false,
        resizable: true,
        width: 120,
      },
      {
        kind: "locale" as const,
        locale: "__value__",
        label: "Value",
        editable: true,
        resizable: true,
        width: 400,
      },
    ];

    const rows = sortedLocales.map(loc => {
      const edited = st.pendingEdits.get(loc);
      let value: string;
      if (edited !== undefined) {
        value = edited;
      } else {
        const doc = st.localeSet!.locales.get(loc)!;
        const entry = doc.entries.find(e => e.name === document.metadata.keyName);
        value = entry?.value ?? '';
      }
      return {
        name: loc ?? '(default)',
        comment: '',
        values: { '__localeLabel__': loc ?? '(default)', '__value__': value },
      };
    });

    return { columns, rows };
  }

  // NOTE: pendingEdits tracking is handled via _updatePendingEditsFromWebview override

  /** Synchronous snapshot of current pendingEdits from the stored state. */
  private getPendingEditsSnapshot(document: BulkEditCustomDocument): Record<string, string> {
    const st = this.getDocState(document);
    if (!st) { return {}; }
    const obj: Record<string, string> = {};
    for (const [k, v] of st.pendingEdits) {
      obj[k === null ? '__null__' : k] = v;
    }
    return obj;
  }

  // ── Override _handleMessage to intercept dirty changes per-document ─

  private _activeDocument: BulkEditCustomDocument | null = null;

  protected override _handleMessage(msg: any): void {
    super._handleMessage(msg);
  }

  // ── CustomEditorProvider lifecycle ────────────────────────────

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
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

    const document = new BulkEditCustomDocument(uri, metadata);

    // Restore pending edits from backup (hot-exit)
    if (openContext.backupId) {
      try {
        const backupBytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId));
        const backupData = JSON.parse(new TextDecoder().decode(backupBytes)) as {
          metadata?: BulkEditTempFileMetadata;
          pendingEdits?: Record<string, string>;
        };
        if (backupData.pendingEdits) {
          const pending = new Map<string | null, string>();
          for (const [k, v] of Object.entries(backupData.pendingEdits)) {
            pending.set(k === '__null__' ? null : k, v);
          }
          document.pendingEditsFromBackup = pending;
        }
      } catch {
        // backup read failed — ignore, start fresh
      }
    }

    return document;
  }

  async resolveCustomEditor(
    document: BulkEditCustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this._activeDocument = document;

    // Load locale set
    let localeSet: ResxLocaleSet | null = null;
    try {
      localeSet = await findRelatedResxFiles(vscode.Uri.parse(document.metadata.sourceUri));
    } catch (err) {
      console.error('[bulkEdit] failed to load locale set', err);
    }

    if (!localeSet) {
      vscode.window.showErrorMessage(
        `RESX Bulk Edit: Could not find related locale files for "${document.metadata.sourceUri}".`
      );
      return;
    }

    // Initialize per-document state
    const pendingEdits = document.pendingEditsFromBackup ?? new Map<string | null, string>();
    document.pendingEditsFromBackup = null; // consume
    this._docState.set(document, {
      localeSet,
      pendingEdits,
      originalValues: new Map(),
    });
    this.storeOriginalValues(document);

    // Build HTML using TableEditProvider
    const { columns, rows } = this.buildTableData(document);
    const title = document.metadata.keyName;

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this._context.extensionPath, 'media'))
      ],
    };

    webviewPanel.webview.html = this.buildHtml(columns, rows, title);

    // Attach message handling (TableEditProvider base)
    this.attach(webviewPanel);

    document.setProvider(this);

    // Additional message listener for BulkEdit-specific tracking
    const sub = webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg.type === 'tableEditDirty' && msg.isDirty) {
        await this.syncPendingEditsFromWebview(document);
        this.fireDirty(document);
      }
      if (msg.type === 'copyToClipboard') {
        vscode.env.clipboard.writeText(msg.text);
      }
    });
    this._disposables.push(sub);

    webviewPanel.onDidDispose(() => {
      if (this._activeDocument === document) {
        this._activeDocument = null;
      }
      this._docState.delete(document);
    }, null, this._disposables);
  }

  /**
   * Refresh pendingEdits by comparing webview state against originalValues.
   * Uses getChanges() which diffs current rows vs snapshot (snapshot = initial load / last save).
   * Each change has row index → we map that to the locale via sortedLocales.
   */
  private async syncPendingEditsFromWebview(document: BulkEditCustomDocument): Promise<void> {
    const st = this.getDocState(document);
    if (!st || !st.localeSet) { return; }

    const sortedLocales = getSortedLocales(st.localeSet, null);
    const changes = await this.getChanges();

    // Start from originalValues, apply changes
    const newPending = new Map<string | null, string>();
    for (const c of changes) {
      if (c.kind === 'cell' && c.locale === '__value__') {
        const locale = c.row < sortedLocales.length ? sortedLocales[c.row] : null;
        newPending.set(locale, c.newValue);
      }
    }
    st.pendingEdits = newPending;
  }

  // ── Save / Revert / Backup ────────────────────────────────────

  async saveCustomDocument(
    document: BulkEditCustomDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    const st = this.getDocState(document);
    if (!st || !st.localeSet) { return; }

    // Sync pendingEdits from current webview state before saving
    await this.syncPendingEditsFromWebview(document);

    if (st.pendingEdits.size === 0) { return; }

    // Write to each locale file
    for (const [locale, value] of st.pendingEdits) {
      if (value === '') { continue; }
      const doc = st.localeSet!.locales.get(locale);
      if (!doc) { continue; }
      const entry = doc.entries.find(e => e.name === document.metadata.keyName);
      if (entry) {
        entry.value = value;
      } else {
        doc.entries.push({ name: document.metadata.keyName, value, comment: '' });
      }
      const xml = serializeResx(doc);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(doc.path),
        new TextEncoder().encode(xml)
      );
    }

    st.pendingEdits.clear();
    await this.reloadLocaleSet(document);
    this.storeOriginalValues(document);

    // Rebuild webview with fresh data
    this.rebuildWebview(document);

    this.resetDirty();

    vscode.window.showInformationMessage(
      `RESX: Saved "${document.metadata.keyName}" to all locale files.`
    );
  }

  async saveCustomDocumentAs(
    document: BulkEditCustomDocument,
    _destination: vscode.Uri,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await this.saveCustomDocument(document, _cancellation);
  }

  async revertCustomDocument(
    document: BulkEditCustomDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    const st = this.getDocState(document);
    if (!st) { return; }

    st.pendingEdits.clear();
    await this.reloadLocaleSet(document);
    this.storeOriginalValues(document);

    this.rebuildWebview(document);
    this.resetDirty();
  }

  async backupCustomDocument(
    document: BulkEditCustomDocument,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    // Collect pending edits: compare current state against original
    const st = this.getDocState(document);
    const pendingObj: Record<string, string> = {};
    if (st && st.pendingEdits.size > 0) {
      for (const [k, v] of st.pendingEdits) {
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

  // ── Rebuild webview content ──────────────────────────────────

  private rebuildWebview(document: BulkEditCustomDocument): void {
    if (!this._panel) { return; }
    const { columns, rows } = this.buildTableData(document);
    this._panel.webview.html = this.buildHtml(columns, rows, document.metadata.keyName);
  }

  // ── Temp File Utilities (static, for use by commands) ────────

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
    const dir = await BulkEditProvider.ensureTempDir(context);
    const fileName = `[Bulk] ${keyName}.resxbulk`;
    const tmpUri = vscode.Uri.file(path.join(dir.fsPath, fileName));
    const metadata: BulkEditTempFileMetadata = {
      sourceUri: sourceUri.toString(),
      keyName
    };

    // If existing temp file has closed flag, it's safe to reuse (just overwrite)
    try {
      const existingBytes = await vscode.workspace.fs.readFile(tmpUri);
      const existingMeta = JSON.parse(new TextDecoder().decode(existingBytes)) as BulkEditTempFileMetadata;
      if (existingMeta.closed) {
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
    const all = await BulkEditProvider.scanAllTempFiles(context);
    return all.filter(item => !item.metadata.closed);
  }

  public static async scanAllTempFiles(
    context: vscode.ExtensionContext
  ): Promise<Array<{ uri: vscode.Uri; metadata: BulkEditTempFileMetadata }>> {
    const dir = await BulkEditProvider.ensureTempDir(context);
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
