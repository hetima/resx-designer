import * as vscode from "vscode";
import { getThemeCssVariables } from "./theme-colors";

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



export class TableEditProvider {
  constructor() {}

  // ── Webview HTML ────────────────────────────────────────────────

  public buildHtml(
    columns: any[],
    rows: any[],
    title: string = "",
    toolbarButtons: ToolbarButton[] = [],
  ): string {
    const config = vscode.workspace.getConfiguration("resx");
    const fontFamily = config.get<string>("fontFamily", "");
    const fontSize = config.get<number>("fontSize", 0);
    const cellPadding = config.get<number>("cellPadding", 4);
    const singleClickEdit = config.get<boolean>("singleClickEdit", true);
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
      background-color: var(--resx-body);
      z-index: 10;
      user-select: none;
      font-weight: 600;
      text-align: left;
    }
    td { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

    /* Selected cell */
    td.selected, th.selected { background-color: var(--resx-selected-bg) !important; }

    /* Editing cell */
    td.editing, th.editing { overflow: visible !important; white-space: pre-wrap !important; overflow-wrap: anywhere !important; max-width: none !important; }

    /* Missing translation */
    td.missing-translation { background-color: var(--resx-missing-bg) !important; }

    /* Column classes */
    .index-col { text-align: right; color: var(--resx-index-fg, var(--resx-fg)); }
    .action-col { text-align: center; padding: 0 2px; cursor: pointer; }
    .action-col-header { text-align: center; padding: 0 2px; }
    .action-col .action-icon { opacity: 0.35; font-size: 16px; line-height: 1; }
    .action-col:hover .action-icon { opacity: 1; }
    .name-col { }
    .comment-col { }
    .value-col { }

    /* Focus / Editable */
    td.editable { outline: none; cursor: text; }
    td.editable:focus { outline: 2px solid var(--resx-focus-border); outline-offset: -2px; background-color: var(--resx-selected-bg); }
    td.editable:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    td.editable.unselected:focus { background-color: var(--resx-selected-bg); }

    /* VS Code theme selection colors */
    td::selection, td *::selection { background: var(--resx-selection-bg); color: var(--resx-selection-fg); }

    /* Column resize handle */
    th { position: relative; }
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
<body data-singleclickedit="${singleClickEdit}">
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
    const singleClickEdit = document.body.dataset.singleclickedit === 'true';
    const editing = new WeakSet();
    const thead = document.getElementById('thead');
    const tbody = document.getElementById('tbody');

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
        else if (col.kind === 'name') th.className = 'name-col';
        else if (col.kind === 'comment') th.className = 'comment-col';
        else if (col.kind === 'locale') th.className = 'value-col locale-header';
        th.textContent = col.label;
        const w = col.width;
        th.style.width = w + 'px';
        th.style.minWidth = w + 'px';
        th.style.maxWidth = w + 'px';
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
          td.style.width = w + 'px';
          td.style.minWidth = w + 'px';
          td.style.maxWidth = w + 'px';

          if (col.kind === 'index') {
            td.className = 'index-col';
            td.textContent = rowIdx + 1;
          } else if (col.kind === 'action') {
            td.className = 'action-col';
            td.dataset.name = row.name;
            td.innerHTML = '<span class="action-icon">⋮</span>';
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
            else { td.dataset.readonly = ''; }
          }

          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    function setupEditable(td) {
      // contentEditable is enabled in startEditing().
      // Keep it false initially regardless of singleClickEdit so that
      // focus from keyboard navigation alone does not start editing.
      td.contentEditable = 'false';
      td.tabIndex = 0;
    }

    function setupReadonly(td) {
      // Allow focus on read-only cells (except index/action)
      const col = columns[parseInt(td.dataset.col, 10)];
      if (col.kind !== 'index' && col.kind !== 'action') {
        td.tabIndex = 0;
      }
    }

    // Keyboard navigation: select and focus only, do not start editing
    function navigateToCell(target) {
      selectCell(target);
      target.focus();
    }

    // For Tab/Enter after confirm: editing is expected to continue
    function moveToCell(target) {
      selectCell(target);
      if (!singleClickEdit && target.classList.contains('editable') && !editing.has(target)) {
        startEditing(target);
      }
      target.focus();
      if (editing.has(target)) focusEnd(target);
    }

    function startEditing(td) {
      if (editing.has(td)) return;
      td.contentEditable = 'true';
      editing.add(td);
      td.classList.add('editing');
    }

    function stopEditing(td) {
      if (!editing.has(td)) return;
      td.contentEditable = 'false';
      editing.delete(td);
      td.classList.remove('editing');
      updateMissingState(td);
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

    // ── Selection ──────────────────────────────────────────────

    let selectedTd = null;

    function selectCell(td) {
      if (selectedTd) selectedTd.classList.remove('selected');
      selectedTd = td;
      if (td) td.classList.add('selected');
    }

    // ── Event: click ───────────────────────────────────────────

    tbody.addEventListener('click', (e) => {
      const td = e.target.closest('td');
      if (!td) return;

      selectCell(td);
      if (td.classList.contains('editable') && singleClickEdit) {
        if (!editing.has(td)) {
          startEditing(td);
          focusEnd(td);
        }
        // keep cursor position on click while editing
      }
    });

    // ── Event: dblclick (when singleClickEdit is off) ──────────

    if (!singleClickEdit) {
      tbody.addEventListener('dblclick', (e) => {
        const td = e.target.closest('td.editable');
        if (!td) return;
        startEditing(td);
        selectCell(td);
        focusEnd(td);
      });
    }

    // ── Event: focusout ─────────────────────────────────────────

    tbody.addEventListener('focusout', (e) => {
      const td = e.target.closest('td.editable');
      if (!td || !editing.has(td)) return;
      // Keep editing state when singleClickEdit; restore otherwise
      if (!singleClickEdit) {
        if (!tbody.contains(document.activeElement)) {
          stopEditing(td);
        }
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

      // Ctrl+C: copy selected cell text
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (active && active.contentEditable === 'true' && window.getSelection()?.toString()) {
          return; // let browser handle native copy
        }
        const td = (active?.closest('td')) || selectedTd;
        if (td) {
          e.preventDefault();
          const text = td.textContent || '';
          navigator.clipboard.writeText(text).catch(() => {
            vscode.postMessage({ type: 'copyToClipboard', text });
          });
        }
        return;
      }

      // 編集モードの振る舞い（編集中セルのみ）
      const _activeTd = active?.closest('td');
      const _isEditingActive = _activeTd && editing.has(_activeTd);
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
          if (nextCol.kind !== 'index' && nextCol.kind !== 'action') break;
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
            if (target) { singleClickEdit ? moveToCell(target) : navigateToCell(target); }
          } else {
            // last row: move to first row of next editable column
            let nextColIdx = colIdx + 1;
            while (nextColIdx < columns.length && !columns[nextColIdx].editable) { nextColIdx++; }
            const destColIdx = nextColIdx < columns.length ? nextColIdx : colIdx;
            const firstRow = tbody.firstElementChild;
            if (firstRow) {
              const target = firstRow.children[destColIdx];
              if (target) { singleClickEdit ? moveToCell(target) : navigateToCell(target); }
            }
          }
        } else {
          // 非編集中: 編集開始（editableなら）
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
            singleClickEdit ? moveToCell(target) : navigateToCell(target);
          }
        }
        return;
      }

      // Escape: close search panel if open, otherwise cancel edit or deselect
      if (e.key === 'Escape') {
        if (!searchPanel.classList.contains('hidden')) {
          closeSearch();
          return;
        }
        if (isEditing) {
          const rowIdx = parseInt(td.dataset.row, 10);
          const colIdx = parseInt(td.dataset.col, 10);
          const col = columns[colIdx];
          let original = '';
          if (col.kind === 'name') original = rows[rowIdx].name;
          else if (col.kind === 'comment') original = rows[rowIdx].comment;
          else if (col.kind === 'locale') original = rows[rowIdx].values[col.locale] || '';
          td.textContent = original;
          stopEditing(td);
          selectCell(td);
          td.focus();
        } else {
          selectCell(null);
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
      selectCell(td);
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

    // ── Init ───────────────────────────────────────────────────

    renderHeader();
    renderBody();
    setupToolbar();
  </script>
</body>
</html>`;
  }

  // ── Utilities ────────────────────────────────────────────────────

  private getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
