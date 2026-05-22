/**
 * TestEditProvider — development sandbox for building the universal grid UI.
 *
 * Opens a standalone webview panel with dummy multi-column data.
 * No file I/O, no resx parsing — pure UI experimentation.
 *
 * Activate via "RESX: Test Edit" command.
 */

import * as vscode from 'vscode';
import { getThemeCssVariables } from './theme-colors';

// ─── Dummy data (multi-column, like ResxEditor) ──────────────────

const DUMMY_COLUMNS = [
  { kind: 'index' as const, locale: null, label: '#', editable: false, resizable: false, width: 40 },
  { kind: 'action' as const, locale: null, label: '', editable: false, resizable: false, width: 24 },
  { kind: 'name' as const, locale: null, label: 'Name', editable: false, resizable: true, width: 100 },
  { kind: 'comment' as const, locale: null, label: 'Comment', editable: false, resizable: true, width: 180 },
  { kind: 'locale' as const, locale: null, label: 'default', editable: true, resizable: true, width: 200 },
  { kind: 'locale' as const, locale: 'ja', label: 'ja', editable: true, resizable: true, width: 200 },
  { kind: 'locale' as const, locale: 'fr', label: 'fr', editable: true, resizable: true, width: 200 },
  { kind: 'locale' as const, locale: 'de', label: 'de', editable: true, resizable: true, width: 100 },
];

const DUMMY_ROWS = [
  {
    name: 'Greeting',
    comment: 'A friendly greeting',
    values: { null: 'Hello', ja: 'こんにちは', fr: 'Bonjour', de: 'Hallo' },
    menuTitle: 'あいさつメッセージ',
    menu: [
      { id: 'duplicate', label: '行を複製' },
      { id: 'separator' },
      { id: 'delete', label: '削除', danger: true },
    ],
  },
  {
    name: 'Farewell',
    comment: 'Saying goodbye',
    values: { null: 'Goodbye', ja: 'さようなら', fr: 'Au revoir', de: 'Auf Wiedersehen' },
    menu: [
      { id: 'duplicate', label: '行を複製' },
      { id: 'delete', label: '削除', danger: true },
    ],
  },
  {
    name: 'Error_InvalidInput',
    comment: 'Validation error',
    values: { null: 'Invalid input.', ja: '入力が無効です。', fr: '', de: '' },
    menu: [
      { id: 'delete', label: '削除', danger: true },
    ],
  },
  {
    name: 'Button_Save',
    comment: 'Save button label',
    values: { null: '&Save', ja: '保存(&S)', fr: 'Enregistrer', de: 'Speichern' },
    // menu なし → action-col クリックで何も表示しない
  },
  {
    name: 'Button_Cancel',
    comment: '',
    values: { null: '&Cancel', ja: 'キャンセル', fr: 'Annuler', de: 'Abbrechen' },
    // menu なし
  },
  {
    name: 'Confirm_Delete',
    comment: 'Multi-line\ntest',
    values: { null: 'Are you sure\nyou want to delete?', ja: '', fr: '', de: '' },
    menu: [
      { id: 'delete', label: '削除', danger: true },
    ],
  },
  {
    name: 'Max_Length_Exceeded',
    comment: 'This text is intentionally very long to test truncation behavior in the table cells. It should show an ellipsis when truncated and expand on click or edit.',
    values: { null: 'This is a very long value that should be truncated when displayed in the cell. Click to expand.', ja: 'これはセルに表示される際に切り捨てられるべき非常に長い値です。クリックして展開してください。', fr: 'Ceci est une valeur très longue qui devrait être tronquée...', de: 'Dies ist ein sehr langer Wert, der abgeschnitten werden sollte...' },
    menu: [
      { id: 'duplicate', label: '行を複製' },
      { id: 'delete', label: '削除', danger: true },
    ],
  },
];

// ─── Provider ─────────────────────────────────────────────────────

export class TestEdit {
  public static readonly viewType = "resx.testEdit";
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Open (or reveal) the test edit panel. */
  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    const htmlProvider = new TestEditProvider();

    this.panel = vscode.window.createWebviewPanel(
      TestEdit.viewType,
      "RESX Test Edit",
      vscode.ViewColumn.One,
      { enableScripts: true },
    );

    this.panel.webview.html = htmlProvider.buildHtml(DUMMY_COLUMNS, DUMMY_ROWS, "Test Edit Panel");

    // Handle webview messages
    const messageSub = this.panel.webview.onDidReceiveMessage((msg: any) => {
      if (msg.type === 'actionMenu') {
        const row = DUMMY_ROWS[msg.rowIdx];
        if (!row) return;
        const action = msg.actionId as string;
        if (action === 'duplicate') {
          vscode.window.showInformationMessage(`Duplicate: ${row.name}`);
        } else if (action === 'delete') {
          vscode.window.showWarningMessage(`Delete: ${row.name}`);
        }
      }
    });

    // Handle theme updates
    const themeSub = vscode.window.onDidChangeActiveColorTheme(() => {
      if (this.panel) {
        const themeVars = getThemeCssVariables();
        this.panel.webview.postMessage({
          type: "updateTheme",
          cssVars: themeVars,
        });
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      messageSub.dispose();
      themeSub.dispose();
    });
  }
}


export class TestEditProvider {
  constructor() {}

  // ── Webview HTML ────────────────────────────────────────────────

  public buildHtml(columns: any[], rows: any[], title: string = ''): string {
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

    const titleHtml = title ? `<div class="page-title">${title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>` : '';
    const columnsJson = JSON.stringify(columns);
    const rowsJson = JSON.stringify(rows);

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
      width: 8px;
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
  </style>
</head>
<body data-singleclickedit="${singleClickEdit}">
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
      // contentEditable は startEditing() で有効化する。
      // singleClickEdit の有無にかかわらず初期状態では false にしておくことで、
      // カーソル移動（キーボードナビゲーション）によるフォーカスだけでは
      // 編集モードに入らないようにする。
      td.contentEditable = 'false';
      td.tabIndex = 0;
    }

    function setupReadonly(td) {
      // 編集不可でもフォーカス可能にする（index/action以外）
      const col = columns[parseInt(td.dataset.col, 10)];
      if (col.kind !== 'index' && col.kind !== 'action') {
        td.tabIndex = 0;
      }
    }

    // キーボードナビゲーション用: 選択とフォーカスのみ、編集開始しない
    function navigateToCell(target) {
      selectCell(target);
      target.focus();
    }

    // Tab/Enter確定後など、編集継続が期待される移動用
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
        // 編集中はクリック位置にカーソルを維持（focusEndしない）
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

      console.log('[TestEdit] cellChanged:', { row: rowIdx, col: colIdx, kind: col.kind, value: value.substring(0, 50) });
    });

    // ── Event: keyboard ────────────────────────────────────────

    document.addEventListener('keydown', (e) => {
      const active = document.activeElement;

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
          console.log('[TestEdit] copy:', text);
        }
        return;
      }

      // 編集モードの振る舞い（編集中セルのみ）
      const _activeTd = active?.closest('td');
      const _isEditingActive = _activeTd && editing.has(_activeTd);
      if (_isEditingActive && active.contentEditable === 'true') {
        if (window.getSelection()?.toString()) {
          return; // テキスト選択中 — ブラウザに任せる
        }
        // 編集中は左右矢印をセル移動に使わない
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
            // 通常: 同列の次の行へ
            const target = nextRow.children[colIdx];
            if (target) { singleClickEdit ? moveToCell(target) : navigateToCell(target); }
          } else {
            // 最終行: 次のeditable列の先頭行へ
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

      // Escape: cancel edit
      if (e.key === 'Escape') {
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

    // ── Init ───────────────────────────────────────────────────

    renderHeader();
    renderBody();
    console.log('[TestEdit] initialized with', rows.length, 'rows x', columns.length, 'columns');
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