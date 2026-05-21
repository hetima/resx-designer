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
  { kind: 'index' as const, locale: null, label: '#', editable: false },
  { kind: 'action' as const, locale: null, label: '', editable: false },
  { kind: 'name' as const, locale: null, label: 'Name', editable: false },
  { kind: 'comment' as const, locale: null, label: 'Comment', editable: false },
  { kind: 'locale' as const, locale: null, label: 'default', editable: true },
  { kind: 'locale' as const, locale: 'ja', label: 'ja', editable: true },
  { kind: 'locale' as const, locale: 'fr', label: 'fr', editable: true },
  { kind: 'locale' as const, locale: 'de', label: 'de', editable: true },
];

const DUMMY_ROWS = [
  {
    name: 'Greeting',
    comment: 'A friendly greeting',
    values: { null: 'Hello', ja: 'こんにちは', fr: 'Bonjour', de: 'Hallo' },
  },
  {
    name: 'Farewell',
    comment: 'Saying goodbye',
    values: { null: 'Goodbye', ja: 'さようなら', fr: 'Au revoir', de: 'Auf Wiedersehen' },
  },
  {
    name: 'Error_InvalidInput',
    comment: 'Validation error',
    values: { null: 'Invalid input.', ja: '入力が無効です。', fr: '', de: '' },
  },
  {
    name: 'Button_Save',
    comment: 'Save button label',
    values: { null: '&Save', ja: '保存(&S)', fr: 'Enregistrer', de: 'Speichern' },
  },
  {
    name: 'Button_Cancel',
    comment: '',
    values: { null: '&Cancel', ja: 'キャンセル', fr: 'Annuler', de: 'Abbrechen' },
  },
  {
    name: 'Confirm_Delete',
    comment: 'Multi-line\ntest',
    values: { null: 'Are you sure\nyou want to delete?', ja: '', fr: '', de: '' },
  },
  {
    name: 'Max_Length_Exceeded',
    comment: 'This text is intentionally very long to test truncation behavior in the table cells. It should show an ellipsis when truncated and expand on click or edit.',
    values: { null: 'This is a very long value that should be truncated when displayed in the cell. Click to expand.', ja: 'これはセルに表示される際に切り捨てられるべき非常に長い値です。クリックして展開してください。', fr: 'Ceci est une valeur très longue qui devrait être tronquée...', de: 'Dies ist ein sehr langer Wert, der abgeschnitten werden sollte...' },
  },
];

// ─── Provider ─────────────────────────────────────────────────────

export class TestEditProvider {

  public static readonly viewType = 'resx.testEdit';

  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Open (or reveal) the test edit panel. */
  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      TestEditProvider.viewType,
      'RESX Test Edit',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    this.panel.webview.html = this.buildHtml();

    this.panel.onDidDispose(() => { this.panel = undefined; });

    // Handle theme updates
    const themeSub = vscode.window.onDidChangeActiveColorTheme(() => {
      if (this.panel) {
        const themeVars = getThemeCssVariables();
        this.panel.webview.postMessage({ type: 'updateTheme', cssVars: themeVars });
      }
    });
    this.panel.onDidDispose(() => themeSub.dispose());
  }

  // ── Webview HTML ────────────────────────────────────────────────

  private buildHtml(): string {
    const config = vscode.workspace.getConfiguration('resx');
    const fontFamily = config.get<string>('fontFamily', '');
    const fontSize = config.get<number>('fontSize', 0);
    const cellPadding = config.get<number>('cellPadding', 4);
    const singleClickEdit = config.get<boolean>('singleClickEdit', true);
    const themeVars = getThemeCssVariables();

    const fontStr = fontFamily
      ? `${fontFamily}, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif`
      : "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
    const fontSizeStr = fontSize > 0 ? `${fontSize}px` : 'inherit';
    const nonce = this.getNonce();

    const columnsJson = JSON.stringify(DUMMY_COLUMNS);
    const rowsJson = JSON.stringify(DUMMY_ROWS);

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
    .index-col { min-width: 40px; max-width: 50px; color: var(--resx-index-fg, var(--resx-fg)); text-align: right; }
    .action-col { min-width: 24px; width: 24px; max-width: 24px; text-align: center; padding: 0 2px; cursor: pointer; }
    .action-col .action-icon { opacity: 0.35; font-size: 16px; line-height: 1; }
    .action-col:hover .action-icon { opacity: 1; }
    .name-col { min-width: 60px; width: 180px; max-width: 180px; }
    .comment-col { min-width: 60px; width: 180px; max-width: 180px; }
    .value-col { min-width: 80px; width: 200px; max-width: 220px; }

    /* Focus / Editable */
    td.editable { outline: none; cursor: text; }
    td.editable:focus { outline: 2px solid var(--resx-focus-border); outline-offset: -2px; background-color: var(--resx-selected-bg); }
    td.editable:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    td.editable.unselected:focus { background-color: var(--resx-selected-bg); }

    /* VS Code theme selection colors */
    td::selection, td *::selection { background: var(--resx-selection-bg); color: var(--resx-selection-fg); }
  </style>
</head>
<body data-singleclickedit="${singleClickEdit}">
  <div class="table-container" id="container">
    <table>
      <thead id="thead"></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <script nonce="${nonce}">
    // ── Stub vscode API ────────────────────────────────────────
    const vscode = {
      postMessage: (msg) => window.postMessage({ source: 'testedit', ...msg }, '*'),
      getState: () => ({}),
      setState: () => {},
    };

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
        else if (col.kind === 'action') th.className = 'action-col';
        else if (col.kind === 'name') th.className = 'name-col';
        else if (col.kind === 'comment') th.className = 'comment-col';
        else if (col.kind === 'locale') th.className = 'value-col locale-header';
        th.textContent = col.label;
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
      if (singleClickEdit) {
        td.contentEditable = 'true';
      } else {
        td.tabIndex = 0;
      }
    }

    function setupReadonly(td) {
      // 編集不可でもフォーカス可能にする（index/action以外）
      const col = columns[parseInt(td.dataset.col, 10)];
      if (col.kind !== 'index' && col.kind !== 'action') {
        td.tabIndex = 0;
      }
    }

    // ── Editing state ──────────────────────────────────────────

    function startEditing(td) {
      if (editing.has(td)) return;
      if (!singleClickEdit) td.contentEditable = 'true';
      editing.add(td);
      td.classList.add('editing');
    }

    function stopEditing(td) {
      if (!editing.has(td)) return;
      if (!singleClickEdit) td.contentEditable = 'false';
      editing.delete(td);
      td.classList.remove('editing');
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
        startEditing(td);
        focusEnd(td);
      }
    });

    // ── Event: dblclick (when singleClickEdit is off) ──────────

    if (!singleClickEdit) {
      tbody.addEventListener('dblclick', (e) => {
        const td = e.target.closest('td.editable');
        if (!td) return;
        td.contentEditable = 'true';
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
          if (target) {
            selectCell(target);
            if (target.classList.contains('editable') && !editing.has(target)) {
              startEditing(target);
            }
            target.focus();
            if (editing.has(target)) focusEnd(target);
          }
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
          if (target) {
            selectCell(target);
            if (target.classList.contains('editable') && !singleClickEdit && !editing.has(target)) {
              target.contentEditable = 'true';
              editing.add(target);
            }
            target.focus();
            if (editing.has(target)) focusEnd(target);
          }
        }
        return;
      }

      // Enter: 編集中なら確定して次のセルへ、非編集中なら編集開始
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isEditing) {
          // 確定: 次のセルへ移動
          stopEditing(td);
          const tr = td.closest('tr');
          const next = tr.nextElementSibling;
          if (next) {
            const colIdx = parseInt(td.dataset.col, 10);
            const target = next.children[colIdx];
            if (target) {
              selectCell(target);
              if (target.classList.contains('editable')) {
                startEditing(target);
                focusEnd(target);
              } else {
                target.focus();
              }
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
            selectCell(target);
            if (target.classList.contains('editable') && !editing.has(target)) {
              startEditing(target);
            }
            target.focus();
            if (editing.has(target)) focusEnd(target);
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
          td.blur();
        }
        selectCell(null);
        return;
      }
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
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
