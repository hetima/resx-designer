import * as vscode from "vscode";
import { getThemeCssVariables } from "./theme-colors";
import type { FullEditState } from "./types/resx";

// ─── Toolbar button definition ──────────────────────────────────

export interface ToolbarButton {
  /** Unique id; used as data-action on the element. */
  id: string;
  /** SVG string or text label rendered inside the button. */
  icon: string;
  /** Tooltip shown on hover. */
  title?: string;
  /** 'left' (default) or 'right'. */
  align?: 'left' | 'right';
  /** Called when the button is clicked. Receives the button element. */
  onClick: (btn: HTMLButtonElement) => void;
}

// ─── Table change record (delta) ────────────────────────────────

export interface TableCellChange {
  kind: 'cell';
  row: number;
  col?: number;
  field?: string;
  locale?: string;
  oldValue: string;
  newValue: string;
}

export interface TableStructuralChange {
  kind: 'structural';
  snapshotRows: number;
  currentRows: number;
}

export type TableChange = TableCellChange | TableStructuralChange;

// ─── Options ────────────────────────────────────────────────────

export interface TableEditOptions {
  /** Called when dirty state changes. */
  onDirtyChange?: (isDirty: boolean) => void;
  /** Called when an undo is performed. */
  onUndo?: () => void;
  /** Called when a redo is performed. */
  onRedo?: () => void;
  /** If true, the webview sends a 'cellEdited' message to the host after each cell change. */
  notifyCellEdits?: boolean;
}

export interface BuildHtmlOptions {
  /** Title displayed at the top of the page (empty string = spacer). */
  title?: string;
  /** Extra inline JavaScript injected before the closing </script> tag. */
  additionalScript?: string;
}


export class TableEditProvider {
  protected _panel?: vscode.WebviewPanel;
  protected _isDirty = false;
  protected _canUndo = false;
  protected _canRedo = false;
  protected _disposables: vscode.Disposable[] = [];
  protected _onDirtyChange?: (isDirty: boolean) => void;
  protected _onUndo?: () => void;
  protected _onRedo?: () => void;
  protected _pendingChangesResolve: ((changes: TableChange[]) => void) | null = null;
  protected _pendingFullStateResolve: ((state: FullEditState) => void) | null = null;
  protected _pendingRestoreAckResolve: (() => void) | null = null;
  protected _notifyCellEdits: boolean;

  constructor(options?: TableEditOptions) {
    this._onDirtyChange = options?.onDirtyChange;
    this._onUndo = options?.onUndo;
    this._onRedo = options?.onRedo;
    this._notifyCellEdits = options?.notifyCellEdits ?? false;
  }

  /** Attach to a webview panel to handle messages. Call after `buildHtml` and setting `panel.webview.html`. */
  public attach(panel: vscode.WebviewPanel): void {
    this._panel = panel;
    const sub = panel.webview.onDidReceiveMessage(msg => this._handleMessage(msg));
    this._disposables.push(sub);
    panel.onDidDispose(() => this._disposables.forEach(d => d.dispose()), null, this._disposables);
  }

  // ── Public state ───────────────────────────────────────────────

  public get isDirty(): boolean { return this._isDirty; }
  public get canUndo(): boolean { return this._canUndo; }
  public get canRedo(): boolean { return this._canRedo; }

  // ── Public actions ─────────────────────────────────────────────

  /** Send undo command to the webview. */
  public performUndo(): void {
    this._panel?.webview.postMessage({ type: 'undo' });
  }

  /** Send redo command to the webview. */
  public performRedo(): void {
    this._panel?.webview.postMessage({ type: 'redo' });
  }

  /** Reset the dirty baseline (call after successful save). */
  public resetDirty(): void {
    this._panel?.webview.postMessage({ type: 'resetSnapshot' });
    this._isDirty = false;
    this._canUndo = false;
    this._canRedo = false;
  }

  /** Request the current changes vs the baseline. Resolves when the webview responds. */
  public async getChanges(): Promise<TableChange[]> {
    if (!this._panel) return [];
    return new Promise<TableChange[]>(resolve => {
      this._pendingChangesResolve = resolve;
      this._panel!.webview.postMessage({ type: 'requestChanges' });
      // Timeout after 2s
      setTimeout(() => {
        if (this._pendingChangesResolve === resolve) {
          this._pendingChangesResolve = null;
          resolve([]);
        }
      }, 2000);
    });
  }

  /** Dispose all resources. */
  public dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
    this._panel = undefined;
  }

  /** Request the full editing state from the webview (for hot-exit backup). Resolves when the webview responds. */
  public getFullState(timeoutMs: number = 2000): Promise<FullEditState> {
    if (!this._panel) {
      return Promise.resolve({ rows: [], snapshotRows: [], undoStack: [], redoStack: [], dirty: false });
    }
    return new Promise<FullEditState>(resolve => {
      this._pendingFullStateResolve = resolve;
      this._panel!.webview.postMessage({ type: 'requestFullState' });
      setTimeout(() => {
        if (this._pendingFullStateResolve === resolve) {
          this._pendingFullStateResolve = null;
          resolve({ rows: [], snapshotRows: [], undoStack: [], redoStack: [], dirty: false });
        }
      }, timeoutMs);
    });
  }

  /** Restore full editing state into the webview (for hot-exit recovery). Resolves when the webview acknowledges. */
  public restoreFullState(state: FullEditState, timeoutMs: number = 2000): Promise<void> {
    if (!this._panel) return Promise.resolve();
    return new Promise<void>(resolve => {
      this._pendingRestoreAckResolve = resolve;
      this._panel!.webview.postMessage({ type: 'restoreFullState', state });
      setTimeout(() => {
        if (this._pendingRestoreAckResolve === resolve) {
          this._pendingRestoreAckResolve = null;
          resolve();
        }
      }, timeoutMs);
    });
  }

  // ── Private ────────────────────────────────────────────────────

  protected _handleMessage(msg: any): void {
    switch (msg.type) {
      case 'tableEditDirty':
        this._isDirty = !!msg.isDirty;
        this._onDirtyChange?.(this._isDirty);
        break;
      case 'tableEditUndo':
        this._onUndo?.();
        break;
      case 'tableEditRedo':
        this._onRedo?.();
        break;
      case 'tableEditChanges':
        if (this._pendingChangesResolve) {
          this._pendingChangesResolve(msg.changes ?? []);
          this._pendingChangesResolve = null;
        }
        break;
      case 'tableEditFullState':
        if (this._pendingFullStateResolve) {
          this._pendingFullStateResolve(msg.state as FullEditState);
          this._pendingFullStateResolve = null;
        }
        break;
      case 'tableEditRestoreAck':
        if (this._pendingRestoreAckResolve) {
          this._pendingRestoreAckResolve();
          this._pendingRestoreAckResolve = null;
        }
        break;
    }
  }

  /** Called when the webview sends a 'cellEdited' message (only when notifyCellEdits is true). */
  protected _onCellEdited?(msg: { row: number; col: number; field?: string; locale?: string; oldValue: string; newValue: string }): void;

  // ── Webview HTML ────────────────────────────────────────────────

  public buildHtml(
    columns: any[],
    rows: any[],
    titleOrOpts: string | BuildHtmlOptions = "",
    toolbarButtons: ToolbarButton[] = [],
  ): string {
    const opts: BuildHtmlOptions = typeof titleOrOpts === 'string'
      ? { title: titleOrOpts }
      : titleOrOpts;
    const title = opts.title ?? "";
    const additionalScript = opts.additionalScript ?? "";
    const config = vscode.workspace.getConfiguration("resx");
    const fontFamily = config.get<string>("fontFamily", "");
    const fontSize = config.get<number>("fontSize", 0);
    const cellPadding = config.get<number>("cellPadding", 4);
    const themeVars = getThemeCssVariables();

    const fontStr = fontFamily
      ? `${fontFamily}, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif`
      : "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
    const fontSizeStr = fontSize > 0 ? `${fontSize}px` : "inherit";
    const nonce = this.getNonce();

    const titleHtml = title
      ? `<div class="page-title">${title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`
      : `<div class="page-title">&nbsp;</div>`;
    const columnsJson = JSON.stringify(columns);
    const rowsJson = JSON.stringify(rows);

    // Built-in toolbar buttons (always added internally)
    const builtinButtons: ToolbarButton[] = [
      {
        id: "__search",
        icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/><line x1="9.85" y1="9.85" x2="13.5" y2="13.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        title: "Search (Ctrl+F)",
        align: "right",
        onClick: () => {
          /* handled in webview via id */
        },
      },
    ];
    const allButtons = [...toolbarButtons, ...builtinButtons];

    // Serialize button metadata (id, icon, title, align) — onClick is wired in JS
    const toolbarButtonsJson = JSON.stringify(
      allButtons.map((b) => ({
        id: b.id,
        icon: b.icon,
        title: b.title ?? "",
        align: b.align ?? "left",
      })),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval';">
  <style>
    :root {
      ${themeVars}
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ${fontStr};
      font-size: ${fontSizeStr};
      background: var(--resx-body);
      color: var(--resx-fg);
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      user-select: none;
    }
    .table-container { overflow: auto; flex: 1; }
    .page-title {padding: 4px 20px; font-weight: 600; font-size: 1.5em; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .toolbar { height: 32px; display: flex; align-items: center; padding: 0 4px; margin-bottom: 4px; border-bottom: 1px solid var(--resx-border); flex-shrink: 0; gap: 4px; }
    .toolbar-spacer { flex: 1; }
    .toolbar-btn { background: transparent; border: 1px solid transparent; border-radius: 3px; color: var(--resx-fg); cursor: pointer; padding: 2px 6px; font-size: 14px; line-height: 1; display: flex; align-items: center; justify-content: center; min-width: 24px; min-height: 24px; }
    .toolbar-btn:hover { background: var(--resx-header-btn-hover-bg); border-color: var(--resx-border); }
    .toolbar-btn:disabled { opacity: 0.35; cursor: default; }
    .toolbar-btn svg { display: block; }
    table { border-collapse: collapse; width: max-content; }
    th, td {
      padding: ${cellPadding}px 8px;
      border: 1px solid var(--resx-border);
      font-size: inherit;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 10;
      background-color: var(--resx-body);
      user-select: none;
      font-weight: 600;
      text-align: left;
      margin: 0;
      padding: 6px 4px;
    }
    /* Column resize handle — th already has position:sticky which establishes containing block */
    .resize-handle {
      position: absolute;
      right: 0;
      top: 0;
      width: 6px;
      height: 100%;
      cursor: col-resize;
      user-select: none;
      z-index: 1;
    }
    .resize-handle:hover, .resize-handle.dragging { background: var(--vscode-focusBorder); opacity: 0.6; }

    /* Selected cell */
    td.selected, th.selected { background-color: var(--resx-selected-bg) !important; }

    /* Editing cell */
    td.editing, th.editing { overflow: visible !important; white-space: pre-wrap !important; overflow-wrap: anywhere !important; max-width: none !important; }

    /* Missing translation */
    td.missing-translation { background-color: var(--resx-missing-bg) !important; }

    /* Column classes */
    .index-col { text-align: right; color: var(--resx-index-fg, var(--resx-fg)); width: auto; }
    .action-col { text-align: center; padding: 0 2px; cursor: pointer; vertical-align: middle; }
    .action-col-header { text-align: center; padding: 0 2px; }
    .action-col .action-icon { opacity: 0.35; font-size: 16px; line-height: 1; }
    .action-col:hover .action-icon { opacity: 1; }
    .checkbox-col { text-align: center; padding: 0 2px; vertical-align: middle; }
    .checkbox-col-header { text-align: center; padding: 0 2px; vertical-align: middle;}
    .checkbox-col input[type="checkbox"] { cursor: pointer; accent-color: var(--vscode-checkbox-background, var(--vscode-focusBorder)); width: 15px; height: 15px; margin: 0; }
    .checkbox-col-header input[type="checkbox"] { cursor: pointer; accent-color: var(--vscode-checkbox-background, var(--vscode-focusBorder)); width: 15px; height: 15px; margin: 0; }
    .name-col { }
    .comment-col { }
    .value-col { }

    /* Readonly cells */
    td[data-readonly] { color: var(--resx-readonly-fg); background-color: var(--resx-readonly-bg); }

    /* Focus / Editable */
    td.editable { outline: none; cursor: text; }
    td.editable:focus { outline: 2px solid var(--resx-focus-border); outline-offset: -2px; background-color: var(--resx-selected-bg); }
    td.editable:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    td.editable.unselected:focus { background-color: var(--resx-selected-bg); }

    /* VS Code theme selection colors */
    td::selection, td *::selection { background: var(--resx-selection-bg); color: var(--resx-selection-fg); }

    /* Action menu */
    .action-menu-overlay { position: fixed; inset: 0; z-index: 9998; }
    .action-menu { position: fixed; z-index: 9999; min-width: 200px; background: var(--resx-body); border: 1px solid var(--resx-border); border-radius: 6px; box-shadow: 0 6px 18px rgba(0,0,0,0.25); padding: 4px; color: var(--resx-fg); font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); font-size: 13px; }
    .action-menu-label { padding: 6px 10px; font-weight: 600; font-size: 12px; color: var(--resx-fg); opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid var(--resx-border); margin-bottom: 2px; }
    .action-menu-item { width: 100%; border: none; background: transparent; color: var(--resx-fg); border-radius: 4px; text-align: left; padding: 5px 10px; cursor: pointer; font-size: 13px; font-family: inherit; display: flex; align-items: center; gap: 8px; }
    .action-menu-item:hover { background: var(--resx-header-btn-hover-bg); }
    .action-menu-item.disabled { opacity: 0.4; pointer-events: none; }
    .action-menu-item.danger { color: var(--vscode-notificationsErrorIcon-foreground, #f44); }
    .action-menu-item.danger:hover { background: rgba(255,80,80,0.1); }
    .action-menu-separator { height: 1px; background: var(--resx-border); margin: 4px 8px; }

    /* Search panel */
    .search-panel { position: fixed; top: 0; right: 0; z-index: 8000; display: flex; align-items: center; gap: 6px; padding: 7px 12px; background: var(--resx-body); border: 1px solid var(--resx-border); border-top: none; border-right: none; border-radius: 0 0 0 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); font-size: 13px; }
    .search-panel.hidden { display: none; }
    .search-input { background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc); border: 1px solid var(--vscode-input-border, #555); border-radius: 3px; padding: 4px 8px; font-size: 13px; width: 220px; outline: none; }
    .search-input:focus { border-color: var(--vscode-focusBorder); }
    .search-input.no-match { border-color: var(--vscode-inputValidation-errorBorder, #f44); background: var(--vscode-inputValidation-errorBackground, #5a1d1d); }
    .search-btn { background: transparent; border: 1px solid transparent; border-radius: 3px; color: var(--resx-fg); cursor: pointer; padding: 3px 7px; font-size: 14px; line-height: 1; display: flex; align-items: center; justify-content: center; min-width: 26px; min-height: 26px; }
    .search-btn:hover { background: var(--resx-header-btn-hover-bg); border-color: var(--resx-border); }
    .search-btn:disabled { opacity: 0.35; cursor: default; }
    .search-btn:disabled:hover { background: transparent; border-color: transparent; }
    .search-toggle { padding: 3px 8px; font-size: 12px; }
    .search-toggle.active { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border-color: transparent; }
    .search-count { font-size: 12px; color: var(--resx-fg); opacity: 0.7; min-width: 72px; text-align: center; white-space: nowrap; }
    .search-sep { width: 1px; height: 18px; background: var(--resx-border); margin: 0 2px; }

    /* Search hit highlight */
    td.search-hit { border-left: 3px solid var(--vscode-editor-findMatchHighlightBorder, #ea5c00) !important; }
  </style>
</head>
<body>
  <div class="search-panel hidden" id="search-panel">
    <input class="search-input" id="search-input" type="text" placeholder="Search..." spellcheck="false">
    <button class="search-btn search-toggle" id="search-case" title="Match Case (Alt+C)">Aa</button>
    <div class="search-sep"></div>
    <span class="search-count" id="search-count"></span>
    <button class="search-btn" id="search-prev" title="Previous (Shift+Enter / Shift+F3)">&#x25B4;</button>
    <button class="search-btn" id="search-next" title="Next (Enter / F3)">&#x25BE;</button>
    <div class="search-sep"></div>
    <button class="search-btn" id="search-close" title="Close (Esc)">&#x2715;</button>
  </div>
  ${titleHtml}
  <div class="toolbar" id="toolbar"></div>
  <div class="table-container" id="container">
    <table>
      <thead id="thead"></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <script nonce="${nonce}">
    // ── vscode API ──────────────────────────────────────────
    const vscode = acquireVsCodeApi();

    // ── Initial data ───────────────────────────────────────────
    const columns = ${columnsJson};
    const rows = ${rowsJson};
    const _notifyCellEdits = ${this._notifyCellEdits};
    const editing = new WeakSet();
    const checkedRows = new Set();
    const thead = document.getElementById('thead');
    const tbody = document.getElementById('tbody');

    function _updateCheckedState() {
      const count = checkedRows.size;
      const hcb = document.getElementById('_headerCheckbox');
      if (hcb) hcb.checked = count > 0 && count === rows.length;
      window._setCheckedCount && window._setCheckedCount(count);
    }

    // ── Table state (dirty, undo/redo) ─────────────────────────
    let _undoStack = [];
    let _redoStack = [];
    let _snapshotRows = [];
    let _dirty = false;
    let _pendingEdit = null; // { row, col, field, oldValue }

    function _cloneRows(src) {
      return src.map(r => ({
        name: r.name, comment: r.comment,
        values: { ...r.values },
        menu: r.menu, menuTitle: r.menuTitle,
      }));
    }
    function _rowsEqual(a, b) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i].name !== b[i].name || a[i].comment !== b[i].comment) return false;
        const keysA = Object.keys(a[i].values), keysB = Object.keys(b[i].values);
        if (keysA.length !== keysB.length) return false;
        for (const k of keysA) {
          if (a[i].values[k] !== b[i].values[k]) return false;
        }
      }
      return true;
    }
    function _takeSnapshot() {
      _snapshotRows = _cloneRows(rows);
      _undoStack = [];
      _redoStack = [];
      _dirty = false;
      _notifyHost('tableEditDirty', { isDirty: false });
    }
    function _recalcDirty() {
      const was = _dirty;
      _dirty = !_rowsEqual(_snapshotRows, rows);
      if (was !== _dirty) _notifyHost('tableEditDirty', { isDirty: _dirty });
    }
    function _recordChange(change) {
      _undoStack.push(change);
      _redoStack = [];
      _recalcDirty();
      if (_notifyCellEdits && change.kind === 'cell') {
        const col = columns[change.col];
        _notifyHost('cellEdited', {
          row: change.row, col: change.col,
          field: change.field,
          locale: col && col.kind === 'locale' ? col.locale : undefined,
          oldValue: change.oldValue, newValue: change.newValue,
        });
      }
    }
    function _performUndo() {
      if (_undoStack.length === 0) return false;
      const change = _undoStack.pop();
      _applyInverse(change);
      _redoStack.push(change);
      _recalcDirty();
      renderBody();
      _notifyHost('tableEditUndo', { isDirty: _dirty });
      return true;
    }
    function _performRedo() {
      if (_redoStack.length === 0) return false;
      const change = _redoStack.pop();
      _applyForward(change);
      _undoStack.push(change);
      _recalcDirty();
      renderBody();
      _notifyHost('tableEditRedo', { isDirty: _dirty });
      return true;
    }
    function _getChanges() {
      if (_snapshotRows.length !== rows.length) {
        return [{ kind: 'structural', snapshotRows: _snapshotRows.length, currentRows: rows.length }];
      }
      const changes = [];
      for (let r = 0; r < rows.length; r++) {
        if (rows[r].name !== _snapshotRows[r].name)
          changes.push({ kind: 'cell', row: r, field: 'name', oldValue: _snapshotRows[r].name, newValue: rows[r].name });
        if (rows[r].comment !== _snapshotRows[r].comment)
          changes.push({ kind: 'cell', row: r, field: 'comment', oldValue: _snapshotRows[r].comment, newValue: rows[r].comment });
        const curV = rows[r].values, snapV = _snapshotRows[r].values;
        const allLoc = new Set([...Object.keys(curV), ...Object.keys(snapV)]);
        for (const loc of allLoc) {
          const cv = curV[loc] ?? '', sv = snapV[loc] ?? '';
          if (cv !== sv) {
            const ci = columns.findIndex(c => c.kind === 'locale' && c.locale === loc);
            changes.push({ kind: 'cell', row: r, col: ci, locale: loc, oldValue: sv, newValue: cv });
          }
        }
      }
      return changes;
    }
    function _notifyHost(type, payload) {
      try { vscode.postMessage({ type, ...payload }); } catch {}
    }
    function _applyInverse(change) {
      switch (change.kind) {
        case 'cell': {
          const row = rows[change.row]; if (!row) return;
          if (change.field === 'name') row.name = change.oldValue;
          else if (change.field === 'comment') row.comment = change.oldValue;
          else if (change.field === 'value') { const col = columns[change.col]; if (col) row.values[col.locale] = change.oldValue; }
          break;
        }
        case 'addRow': rows.splice(change.index, 1); break;
        case 'deleteRow': rows.splice(change.index, 0, change.rowData); break;
        case 'sort': {
          const snapNames = _snapshotRows.map(r => r.name);
          const rowMap = new Map(rows.map(r => [r.name, r]));
          rows.length = 0;
          for (const name of snapNames) { const e = rowMap.get(name); if (e) rows.push(e); }
          const snapSet = new Set(snapNames);
          for (const r of rowMap.values()) { if (!snapSet.has(r.name)) rows.push(r); }
          break;
        }
        case 'deleteRows': {
          const sorted = [...change.rowsData].sort((a, b) => a.index - b.index);
          for (let i = sorted.length - 1; i >= 0; i--) rows.splice(sorted[i].index, 0, sorted[i].data);
          break;
        }
      }
    }
    function _applyForward(change) {
      switch (change.kind) {
        case 'cell': {
          const row = rows[change.row]; if (!row) return;
          if (change.field === 'name') row.name = change.newValue;
          else if (change.field === 'comment') row.comment = change.newValue;
          else if (change.field === 'value') { const col = columns[change.col]; if (col) row.values[col.locale] = change.newValue; }
          break;
        }
        case 'addRow': rows.splice(change.index, 0, change.rowData); break;
        case 'deleteRow': rows.splice(change.index, 1); break;
        case 'sort': {
          const rowMap = new Map(rows.map(r => [r.name, r]));
          rows.length = 0;
          for (const name of change.newOrder) { const e = rowMap.get(name); if (e) rows.push(e); }
          const sortedSet = new Set(change.newOrder);
          for (const r of rowMap.values()) { if (!sortedSet.has(r.name)) rows.push(r); }
          break;
        }
        case 'deleteRows': {
          const indices = change.rowsData.map(r => r.index).sort((a, b) => b - a);
          for (const idx of indices) rows.splice(idx, 1);
          break;
        }
      }
    }
    // Expose for host API calls via message
    window.__tableState = {
      isDirty: () => _dirty,
      canUndo: () => _undoStack.length > 0,
      canRedo: () => _redoStack.length > 0,
      getChanges: () => _getChanges(),
      undo: () => _performUndo(),
      redo: () => _performRedo(),
      takeSnapshot: () => _takeSnapshot(),
    };

    // ── Toolbar ────────────────────────────────────────────────

    const toolbarDef = ${toolbarButtonsJson};

    function setupToolbar() {
      const bar = document.getElementById('toolbar');
      const leftFrag = document.createDocumentFragment();
      const rightFrag = document.createDocumentFragment();
      let hasRight = false;

      toolbarDef.forEach(def => {
        const btn = document.createElement('button');
        btn.className = 'toolbar-btn';
        btn.dataset.action = def.id;
        btn.innerHTML = def.icon;
        if (def.title) btn.title = def.title;
        btn.addEventListener('click', () => handleToolbarAction(def.id, btn));
        if (def.align === 'right') {
          rightFrag.appendChild(btn);
          hasRight = true;
        } else {
          leftFrag.appendChild(btn);
        }
      });

      bar.appendChild(leftFrag);
      if (hasRight) {
        const spacer = document.createElement('div');
        spacer.className = 'toolbar-spacer';
        bar.appendChild(spacer);
        bar.appendChild(rightFrag);
      }
    }

    function handleToolbarAction(id, btn) {
      // Built-in actions
      if (id === '__search') { openSearch(); return; }
      // User-defined: notify host
      vscode.postMessage({ type: 'toolbarAction', actionId: id });
    }

    // ── Helpers ────────────────────────────────────────────────

    function focusEnd(cell) {
      cell.focus();
      const range = document.createRange();
      range.selectNodeContents(cell);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function escapeHtml(text) {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Render ─────────────────────────────────────────────────

    function renderHeader() {
      thead.innerHTML = '';
      const tr = document.createElement('tr');
      columns.forEach((col, idx) => {
        const th = document.createElement('th');
        th.dataset.col = idx;
        if (col.kind === 'index') th.className = 'index-col';
        else if (col.kind === 'action') th.className = 'action-col-header';
        else if (col.kind === 'checkbox') th.className = 'checkbox-col-header';
        else if (col.kind === 'name') th.className = 'name-col';
        else if (col.kind === 'comment') th.className = 'comment-col';
        else if (col.kind === 'locale') th.className = 'value-col locale-header';
        if (col.kind === 'checkbox') {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.id = '_headerCheckbox';
          cb.title = 'Select / Deselect All';
          cb.addEventListener('change', () => {
            const on = cb.checked;
            checkedRows.clear();
            if (on) rows.forEach(r => checkedRows.add(r.name));
            tbody.querySelectorAll('.checkbox-col input[type="checkbox"]').forEach(el => el.checked = on);
            _updateCheckedState();
          });
          th.appendChild(cb);
        } else {
          th.textContent = col.label;
        }
        const w = col.width;
        if (w === 'auto') {
          th.style.width = 'auto';
        } else {
          th.style.width = w + 'px';
          th.style.minWidth = w + 'px';
          th.style.maxWidth = w + 'px';
        }
        if (col.resizable) {
          const handle = document.createElement('div');
          handle.className = 'resize-handle';
          handle.dataset.col = idx;
          th.appendChild(handle);
        }
        tr.appendChild(th);
      });
      thead.appendChild(tr);
    }

    function renderBody() {
      tbody.innerHTML = '';
      rows.forEach((row, rowIdx) => {
        const tr = document.createElement('tr');
        columns.forEach((col, colIdx) => {
          const td = document.createElement('td');
          td.dataset.row = rowIdx;
          td.dataset.col = colIdx;
          const w = col.width;
          if (w !== 'auto') {
            td.style.width = w + 'px';
            td.style.minWidth = w + 'px';
            td.style.maxWidth = w + 'px';
          }

          if (col.kind === 'index') {
            td.className = 'index-col';
            td.textContent = rowIdx + 1;
          } else if (col.kind === 'action') {
            td.className = 'action-col';
            td.dataset.name = row.name;
            td.innerHTML = '<span class="action-icon">⋯</span>';
          } else if (col.kind === 'checkbox') {
            td.className = 'checkbox-col';
            td.dataset.name = row.name;
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = checkedRows.has(row.name);
            cb.addEventListener('change', () => {
              if (cb.checked) checkedRows.add(row.name); else checkedRows.delete(row.name);
              _updateCheckedState();
            });
            td.appendChild(cb);
          } else if (col.kind === 'name') {
            td.className = 'name-col';
            td.textContent = row.name;
            if (col.editable) { td.classList.add('editable'); setupEditable(td); }
            else { td.dataset.readonly = ''; setupReadonly(td); }
          } else if (col.kind === 'comment') {
            td.className = 'comment-col';
            td.textContent = row.comment;
            if (col.editable) { td.classList.add('editable'); setupEditable(td); }
            else { td.dataset.readonly = ''; setupReadonly(td); }
          } else if (col.kind === 'locale') {
            const value = row.values[col.locale] || '';
            const missing = (col.locale !== null && (!value || value === row.values[null]));
            td.className = 'value-col' + (missing ? ' missing-translation' : '');
            td.textContent = value;
            if (value.indexOf('\\n') >= 0 || value.indexOf('\\r') >= 0) {
              td.title = value;
            }
            if (col.editable) { td.classList.add('editable'); setupEditable(td); }
            else { td.dataset.readonly = ''; setupReadonly(td); }
          }

          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    function setupEditable(td) {
      // contentEditable is enabled in startEditing().
      td.contentEditable = 'false';
      td.tabIndex = 0;
    }

    function setupReadonly(td) {
      // Allow focus on read-only cells (except index/action)
      const col = columns[parseInt(td.dataset.col, 10)];
      if (col.kind !== 'index' && col.kind !== 'action' && col.kind !== 'checkbox') {
        td.tabIndex = 0;
      }
    }

    // Keyboard navigation: select and focus only, do not start editing
    function navigateToCell(target) {
      selectCell(target);
    }

    // After confirm (Enter/Tab): move and start editing
    function moveToCell(target) {
      selectCell(target);
      if (target.classList.contains('editable') && !editing.has(target)) {
        startEditing(target);
      }
    }

    function startEditing(td) {
      if (editing.has(td)) return;
      td.contentEditable = 'true';
      editing.add(td);
      td.classList.add('editing');
      // Store original value for undo tracking
      const rowIdx = parseInt(td.dataset.row, 10);
      const colIdx = parseInt(td.dataset.col, 10);
      const col = columns[colIdx];
      let field = 'value', oldValue = '';
      if (col.kind === 'name') { field = 'name'; oldValue = rows[rowIdx].name; }
      else if (col.kind === 'comment') { field = 'comment'; oldValue = rows[rowIdx].comment; }
      else if (col.kind === 'locale') { field = 'value'; oldValue = rows[rowIdx].values[col.locale] || ''; }
      _pendingEdit = { row: rowIdx, col: colIdx, field, oldValue };
    }

    function cancelEditing(td) {
      if (!editing.has(td)) return;
      // Revert rows data to pre-edit value
      if (_pendingEdit) {
        const p = _pendingEdit;
        if (p.field === 'name') rows[p.row].name = p.oldValue;
        else if (p.field === 'comment') rows[p.row].comment = p.oldValue;
        else if (p.field === 'value') rows[p.row].values[columns[p.col].locale] = p.oldValue;
        td.textContent = p.oldValue;
        _pendingEdit = null;
      }
      td.contentEditable = 'false';
      editing.delete(td);
      td.classList.remove('editing');
      updateMissingState(td);
      // No _recordChange — this is a cancel
    }

    function stopEditing(td) {
      if (!editing.has(td)) return;
      td.contentEditable = 'false';
      editing.delete(td);
      td.classList.remove('editing');
      updateMissingState(td);
      // Record change if value actually changed
      if (_pendingEdit) {
        const p = _pendingEdit;
        const newRow = rows[p.row];
        let newValue = '';
        if (p.field === 'name') newValue = newRow.name;
        else if (p.field === 'comment') newValue = newRow.comment;
        else if (p.field === 'value') newValue = newRow.values[columns[p.col].locale] || '';
        if (p.oldValue !== newValue) {
          _recordChange({ kind: 'cell', row: p.row, col: p.col, field: p.field, oldValue: p.oldValue, newValue });
        }
        _pendingEdit = null;
      }
    }

    function updateMissingState(td) {
      const colIdx = parseInt(td.dataset.col, 10);
      const rowIdx = parseInt(td.dataset.row, 10);
      const col = columns[colIdx];
      if (col.kind !== 'locale' || col.locale === null) return;
      const value = rows[rowIdx].values[col.locale] || '';
      const defaultValue = rows[rowIdx].values[null] || '';
      const missing = !value || value === defaultValue;
      td.classList.toggle('missing-translation', missing);
    }

    // ── View state persistence ─────────────────────────────────

    const _container = document.getElementById('container');

    function _saveViewState() {
      try {
        const st = vscode.getState() || {};
        const colWidths = [];
        thead.querySelectorAll('th').forEach(th => {
          colWidths.push(th.style.width && th.style.width !== 'auto' ? parseInt(th.style.width, 10) : undefined);
        });
        st.viewState = {
          scrollX: _container ? _container.scrollLeft : 0,
          scrollY: _container ? _container.scrollTop : 0,
          selRow: selectedTd ? parseInt(selectedTd.dataset.row, 10) : undefined,
          selCol: selectedTd ? parseInt(selectedTd.dataset.col, 10) : undefined,
          colWidths: colWidths.some(w => w !== undefined) ? colWidths : undefined,
        };
        vscode.setState(st);
      } catch {}
    }

    function _restoreViewState() {
      try {
        const st = vscode.getState();
        const vs = st && st.viewState;
        if (!vs) return;
        if (_container) {
          if (typeof vs.scrollX === 'number') _container.scrollLeft = vs.scrollX;
          if (typeof vs.scrollY === 'number') _container.scrollTop = vs.scrollY;
        }
        if (Array.isArray(vs.colWidths)) {
          vs.colWidths.forEach((w, colIdx) => {
            if (typeof w !== 'number') return;
            const th = thead.querySelector('th:nth-child(' + (colIdx + 1) + ')');
            if (th) {
              th.style.width = w + 'px';
              th.style.minWidth = w + 'px';
              th.style.maxWidth = w + 'px';
            }
            tbody.querySelectorAll('tr td:nth-child(' + (colIdx + 1) + ')').forEach(td => {
              td.style.width = w + 'px';
              td.style.minWidth = w + 'px';
              td.style.maxWidth = w + 'px';
            });
          });
        }
        if (typeof vs.selRow === 'number' && typeof vs.selCol === 'number') {
          const td = tbody.querySelector('td[data-row="' + vs.selRow + '"][data-col="' + vs.selCol + '"]');
          if (td) selectCell(td, { skipFocus: true });
        }
      } catch {}
    }

    if (_container) {
      _container.addEventListener('scroll', () => _saveViewState(), { passive: true });
    }

    // ── Selection ──────────────────────────────────────────────

    let selectedTd = null;

    function selectCell(td, { skipFocus = false } = {}) {
      if (selectedTd) {
        selectedTd.classList.remove('selected');
        if (!skipFocus) { selectedTd.blur(); }
      }
      selectedTd = td;
      if (td) {
        td.classList.add('selected');
        if (!skipFocus) { td.focus(); }
      }
      _saveViewState();
    }

    // ── Event: focusin ───────────────────────────────────────────

    let _suppressEditOnFocus = false;

    tbody.addEventListener('focusin', (e) => {
      const td = e.target.closest('td');
      if (!td) return;
      selectCell(td);
      if (!_suppressEditOnFocus && td.classList.contains('editable') && !editing.has(td)) {
        startEditing(td);
        focusEnd(td);
      }
    });

    // ── Event: focusout ─────────────────────────────────────────

    tbody.addEventListener('focusout', (e) => {
      const td = e.target.closest('td.editable');
      if (!td || !editing.has(td)) return;
      if (!td.contains(document.activeElement)) {
        stopEditing(td);
      }
    });

    // ── Event: input ───────────────────────────────────────────

    tbody.addEventListener('input', (e) => {
      const td = e.target.closest('td.editable');
      if (!td) return;
      const rowIdx = parseInt(td.dataset.row, 10);
      const colIdx = parseInt(td.dataset.col, 10);
      const col = columns[colIdx];
      const value = td.textContent || '';

      if (col.kind === 'name') rows[rowIdx].name = value;
      else if (col.kind === 'comment') rows[rowIdx].comment = value;
      else if (col.kind === 'locale') rows[rowIdx].values[col.locale] = value;

    });

    // ── Event: keyboard ────────────────────────────────────────

    document.addEventListener('keydown', (e) => {
      const active = document.activeElement;

      // Ctrl+Z / Cmd+Z: undo
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        _performUndo();
        return;
      }
      // Ctrl+Y / Ctrl+Shift+Z / Cmd+Shift+Z: redo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z') || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        _performRedo();
        return;
      }

      // Ctrl+F: open search panel
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        openSearch();
        return;
      }

      // F3 / Shift+F3 / Ctrl+G: search navigation (open panel if closed)
      if (e.key === 'F3' || ((e.ctrlKey || e.metaKey) && e.key === 'g')) {
        e.preventDefault();
        if (searchPanel.classList.contains('hidden')) { openSearch(); return; }
        searchNavigate(e.shiftKey ? -1 : +1);
        return;
      }

      // Ctrl+V: paste clipboard text into selected editable cell (not editing)
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        if (active && active.contentEditable === 'true') {
          return; // editing: let browser handle
        }
        if (selectedTd && !editing.has(selectedTd) && selectedTd.classList.contains('editable')) {
          navigator.clipboard.readText().then(text => {
            if (!text) return;
            e.preventDefault();
            const rowIdx = parseInt(selectedTd.dataset.row, 10);
            const colIdx = parseInt(selectedTd.dataset.col, 10);
            const col = columns[colIdx];
            let oldValue = '';
            if (col.kind === 'name') oldValue = rows[rowIdx].name;
            else if (col.kind === 'comment') oldValue = rows[rowIdx].comment;
            else if (col.kind === 'locale') oldValue = rows[rowIdx].values[col.locale] || '';
            if (oldValue === text) return;
            if (col.kind === 'name') rows[rowIdx].name = text;
            else if (col.kind === 'comment') rows[rowIdx].comment = text;
            else if (col.kind === 'locale') rows[rowIdx].values[col.locale] = text;
            selectedTd.textContent = text;
            updateMissingState(selectedTd);
            _recordChange({ kind: 'cell', row: rowIdx, col: colIdx, field: col.kind === 'locale' ? 'value' : col.kind, oldValue, newValue: text });
          }).catch(() => {});
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (active && active.contentEditable === 'true') {
          return; // editing: let browser handle
        }
        if (selectedTd && !editing.has(selectedTd)) {
          const text = selectedTd.textContent || '';
          if (text) {
            e.preventDefault();
            navigator.clipboard.writeText(text).catch(() => {
              vscode.postMessage({ type: 'copyToClipboard', text });
            });
          }
        }
        return;
      }

      // 編集モードの振る舞い（編集中セルのみ）
      const _activeTd = active?.closest('td');
      const _isEditingActive = _activeTd && editing.has(_activeTd);

      // Escape: close search panel if open, otherwise confirm editing (keep changes) or deselect
      if (e.key === 'Escape') {
        if (!searchPanel.classList.contains('hidden')) {
          closeSearch();
          return;
        }
        const _escTd = _activeTd || selectedTd;
        if (_escTd && editing.has(_escTd)) {
          stopEditing(_escTd);
          // Suppress auto-edit on the focusin that selectCell triggers
          _suppressEditOnFocus = true;
          selectCell(_escTd);
          requestAnimationFrame(() => { _suppressEditOnFocus = false; });
        } else {
          selectCell(null);
        }
        return;
      }

      if (_isEditingActive && active.contentEditable === 'true') {
        if (window.getSelection()?.toString()) {
          // let browser handle text selection
          return;
        }
        // do not use arrow keys for cell navigation while editing
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return;
      }

      const td = _activeTd || selectedTd;
      if (!td) return;
      const isEditing = editing.has(td);

      // ↑↓: move between rows (same column type)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const tr = td.closest('tr');
        const next = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
        if (next) {
          const colIdx = parseInt(td.dataset.col, 10);
          const target = next.children[colIdx];
          if (target) { navigateToCell(target); }
        }
        return;
      }

      // ←→: move between columns (skip index and action)
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const colIdx = parseInt(td.dataset.col, 10);
        const step = e.key === 'ArrowRight' ? 1 : -1;
        let nextColIdx = colIdx + step;
        while (nextColIdx >= 0 && nextColIdx < columns.length) {
          const nextCol = columns[nextColIdx];
          if (nextCol.kind !== 'index' && nextCol.kind !== 'action' && nextCol.kind !== 'checkbox') break;
          nextColIdx += step;
        }
        if (nextColIdx >= 0 && nextColIdx < columns.length) {
          e.preventDefault();
          const target = td.closest('tr').children[nextColIdx];
          if (target) { navigateToCell(target); }
        }
        return;
      }

      // Enter: 編集中なら確定して次のセルへ、非編集中なら編集開始
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isEditing) {
          stopEditing(td);
          const colIdx = parseInt(td.dataset.col, 10);
          const tr = td.closest('tr');
          const nextRow = tr.nextElementSibling;
          if (nextRow) {
            // normal: move to next row in same column
            const target = nextRow.children[colIdx];
            if (target) { navigateToCell(target); }
          } else {
            // last row: move to first row of next editable column
            let nextColIdx = colIdx + 1;
            while (nextColIdx < columns.length && !columns[nextColIdx].editable) { nextColIdx++; }
            const destColIdx = nextColIdx < columns.length ? nextColIdx : colIdx;
            const firstRow = tbody.firstElementChild;
            if (firstRow) {
              const target = firstRow.children[destColIdx];
              if (target) { navigateToCell(target); }
            }
          }
        } else {
          // not editing: start editing if editable
          if (td.classList.contains('editable')) {
            startEditing(td);
            focusEnd(td);
          }
        }
        return;
      }

      // Tab / Shift+Tab: next/prev row same column
      if (e.key === 'Tab') {
        e.preventDefault();
        const tr = td.closest('tr');
        const next = e.shiftKey ? tr.previousElementSibling : tr.nextElementSibling;
        if (next) {
          const colIdx = parseInt(td.dataset.col, 10);
          const target = next.children[colIdx];
          if (target) {
            if (isEditing) stopEditing(td);
            navigateToCell(target);
          }
        }
        return;
      }

    });

    // ── Action menu ───────────────────────────────────────────

    let actionMenuEl = null;
    let actionMenuOverlay = null;

    function closeActionMenu() {
      if (actionMenuOverlay) { actionMenuOverlay.remove(); actionMenuOverlay = null; }
      if (actionMenuEl) { actionMenuEl.remove(); actionMenuEl = null; }
    }

    function openActionMenu(cell, clientX, clientY) {
      closeActionMenu();
      const rowIdx = parseInt(cell.dataset.row, 10);
      const row = rows[rowIdx];
      const menuItems = row.menu;
      if (!menuItems || menuItems.length === 0) return;

      actionMenuOverlay = document.createElement('div');
      actionMenuOverlay.className = 'action-menu-overlay';
      document.body.appendChild(actionMenuOverlay);

      actionMenuEl = document.createElement('div');
      actionMenuEl.className = 'action-menu';

      let html = '';
      const menuTitle = row.menuTitle || row.name;
      html += '<div class="action-menu-label" title="' + escapeHtml(menuTitle) + '">' + escapeHtml(menuTitle) + '</div>';

      menuItems.forEach(item => {
        if (item.id === 'separator') {
          html += '<div class="action-menu-separator"></div>';
        } else {
          const cls = (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '');
          html += '<button class="action-menu-item' + cls + '" data-action="' + escapeHtml(item.id) + '">' + escapeHtml(item.label) + '</button>';
        }
      });
      actionMenuEl.innerHTML = html;
      document.body.appendChild(actionMenuEl);

      // Position: ensure it stays within viewport
      let x = clientX;
      let y = clientY;
      const menuRect = actionMenuEl.getBoundingClientRect();
      if (x + 210 > window.innerWidth) x = window.innerWidth - 220;
      if (y + menuRect.height > window.innerHeight) y = clientY - menuRect.height;
      actionMenuEl.style.left = x + 'px';
      actionMenuEl.style.top = y + 'px';

      // Menu item actions
      actionMenuEl.querySelectorAll('.action-menu-item[data-action]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const action = btn.getAttribute('data-action');
          vscode.postMessage({ type: 'actionMenu', actionId: action, rowIdx });
          closeActionMenu();
        });
      });

      // Close on overlay click
      actionMenuOverlay.addEventListener('click', closeActionMenu);

      // Close on Escape
      const onKey = e => {
        if (e.key === 'Escape') { closeActionMenu(); document.removeEventListener('keydown', onKey); }
      };
      document.addEventListener('keydown', onKey);
    }

    // Close menu on any other click outside
    document.addEventListener('click', e => {
      if (actionMenuEl && !actionMenuEl.contains(e.target)) {
        closeActionMenu();
      }
    });

    // ── Event: click (tbody) ─────────────────────────────────

    tbody.addEventListener('click', (e) => {
      const td = e.target.closest('td');
      if (!td) return;
      if (td.classList.contains('action-col')) return;
      // If already focused+selected but not editing (e.g. after Esc), start editing
      if (td === selectedTd && td.classList.contains('editable') && !editing.has(td)) {
        startEditing(td);
        focusEnd(td);
      }
    });

    // ── Event: click (action-col) ─────────────────────────────

    tbody.addEventListener('click', (e) => {
      const td = e.target.closest('td');
      if (!td || !td.classList.contains('action-col')) return;
      e.stopPropagation();
      openActionMenu(td, e.clientX, e.clientY);
    });

    // ── Host → Webview messages ────────────────────────────────

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'updateTheme') {
        let styleEl = document.getElementById('theme-vars');
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = 'theme-vars';
          document.head.appendChild(styleEl);
        }
        styleEl.textContent = ':root { ' + msg.cssVars + ' }';
      } else if (msg.type === 'requestFullState') {
        vscode.postMessage({
          type: 'tableEditFullState',
          state: { rows: _cloneRows(rows), snapshotRows: _cloneRows(_snapshotRows), undoStack: [..._undoStack], redoStack: [..._redoStack], dirty: _dirty }
        });
      } else if (msg.type === 'restoreFullState' && msg.state) {
        // Restore rows and internal state from host
        const s = msg.state;
        _snapshotRows = _cloneRows(s.snapshotRows || []);
        _undoStack = s.undoStack || [];
        _redoStack = s.redoStack || [];
        _dirty = !!s.dirty;
        // Replace live rows array contents in-place so that existing references work
        rows.length = 0;
        for (const r of (s.rows || [])) {
          rows.push({ name: r.name, comment: r.comment, values: { ...r.values }, menu: r.menu, menuTitle: r.menuTitle });
        }
        renderBody();
        vscode.postMessage({ type: 'tableEditRestoreAck' });
      } else if (msg.type === 'undo') {
        _performUndo();
      } else if (msg.type === 'redo') {
        _performRedo();
      } else if (msg.type === 'resetSnapshot') {
        _takeSnapshot();
      } else if (msg.type === 'restoreViewState') {
        requestAnimationFrame(() => _restoreViewState());
      }
    });

    // ── Column resize ───────────────────────────────────────────

    let resizing = null; // { colIdx, startX, startWidth, th, handle }

    thead.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('.resize-handle');
      if (!handle) return;
      e.preventDefault();
      const colIdx = parseInt(handle.dataset.col, 10);
      const th = handle.closest('th');
      resizing = { colIdx, startX: e.clientX, startWidth: th.offsetWidth, th, handle };
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const delta = e.clientX - resizing.startX;
      const newWidth = Math.max(40, resizing.startWidth + delta);
      // th の幅を変更
      resizing.th.style.width = newWidth + 'px';
      resizing.th.style.minWidth = newWidth + 'px';
      resizing.th.style.maxWidth = newWidth + 'px';
      // 同列の td の幅も変更
      const tds = tbody.querySelectorAll('tr td:nth-child(' + (resizing.colIdx + 1) + ')');
      tds.forEach(td => {
        td.style.width = newWidth + 'px';
        td.style.minWidth = newWidth + 'px';
        td.style.maxWidth = newWidth + 'px';
      });
    });

    document.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing.handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      resizing = null;
      _saveViewState();
    });

    // ── Search ─────────────────────────────────────────────────

    const searchPanel   = document.getElementById('search-panel');
    const searchInput   = document.getElementById('search-input');
    const searchCase    = document.getElementById('search-case');
    const searchPrev    = document.getElementById('search-prev');
    const searchNext    = document.getElementById('search-next');
    const searchClose   = document.getElementById('search-close');
    const searchCount   = document.getElementById('search-count');

    let searchHits      = [];  // Array<td>
    let searchCursor    = -1;
    let caseSensitive   = false;

    function getCellText(td) {
      return td.textContent || '';
    }

    function runSearch() {
      const query = searchInput.value;
      searchHits.forEach(td => td.classList.remove('search-hit'));
      searchHits = [];
      searchCursor = -1;

      if (!query) {
        searchCount.textContent = '';
        searchInput.classList.remove('no-match');
        updateSearchNavButtons();
        return;
      }

      const needle = caseSensitive ? query : query.toLowerCase();
      tbody.querySelectorAll('td').forEach(td => {
        const col = columns[parseInt(td.dataset.col, 10)];
        if (!col || col.kind === 'index' || col.kind === 'action') return;
        const hay = caseSensitive ? getCellText(td) : getCellText(td).toLowerCase();
        if (hay.includes(needle)) searchHits.push(td);
      });

      searchHits.forEach(td => td.classList.add('search-hit'));
      searchInput.classList.toggle('no-match', searchHits.length === 0);

      if (searchHits.length > 0) {
        // jump to closest hit to current selection, else first
        let startIdx = 0;
        if (selectedTd) {
          const selRow = parseInt(selectedTd.dataset.row, 10);
          const selCol = parseInt(selectedTd.dataset.col, 10);
          let best = -1, bestDist = Infinity;
          searchHits.forEach((td, i) => {
            const r = parseInt(td.dataset.row, 10);
            const c = parseInt(td.dataset.col, 10);
            const dist = Math.abs(r - selRow) * 1000 + Math.abs(c - selCol);
            if (dist < bestDist) { bestDist = dist; best = i; }
          });
          if (best >= 0) startIdx = best;
        }
        setSearchCursor(startIdx);
      } else {
        searchCount.textContent = '0 results';
      }
      updateSearchNavButtons();
    }

    function setSearchCursor(idx) {
      if (searchHits.length === 0) return;
      searchCursor = (idx + searchHits.length) % searchHits.length;
      const td = searchHits[searchCursor];
      searchCount.textContent = (searchCursor + 1) + ' of ' + searchHits.length;
      // Select without focusing the cell (keeps focus in search input)
      selectCell(td, { skipFocus: true });
      td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function searchNavigate(dir) {
      if (searchHits.length === 0) return;
      setSearchCursor(searchCursor + dir);
    }

    function updateSearchNavButtons() {
      const has = searchHits.length > 0;
      searchPrev.disabled = !has;
      searchNext.disabled = !has;
    }

    function openSearch() {
      searchPanel.classList.remove('hidden');
      searchInput.focus();
      searchInput.select();
      if (searchInput.value) runSearch();
    }

    function closeSearch() {
      searchPanel.classList.add('hidden');
      searchHits.forEach(td => td.classList.remove('search-hit'));
      searchHits = [];
      searchCursor = -1;
      searchCount.textContent = '';
      searchInput.classList.remove('no-match');
      // search word is preserved
    }

    searchInput.addEventListener('input', () => runSearch());

    searchCase.addEventListener('click', () => {
      caseSensitive = !caseSensitive;
      searchCase.classList.toggle('active', caseSensitive);
      runSearch();
    });

    searchNext.addEventListener('click', () => searchNavigate(+1));
    searchPrev.addEventListener('click', () => searchNavigate(-1));
    searchClose.addEventListener('click', () => closeSearch());

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        searchNavigate(e.shiftKey ? -1 : +1);
      }
    });

    // ── Host → Webview messages (table state commands) ─────────

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'requestChanges') {
        _notifyHost('tableEditChanges', { changes: _getChanges() });
      }
    });

    // ── Init ───────────────────────────────────────────────────

    renderHeader();
    renderBody();
    _restoreViewState();
    setupToolbar();
    _takeSnapshot();
    ${additionalScript}
  </script>
</body>
</html>`;
  }

  // ── Utilities ────────────────────────────────────────────────────

  protected getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
