// RESX Editor Webview Script
// Adapted from CSV editor – retains selection, editing, find/replace, zoom, context menu.

document.body.setAttribute('tabindex', '0');
try { document.body.focus({ preventScroll: true }); } catch { try { document.body.focus(); } catch {} }

const vscode = acquireVsCodeApi();

const root = document.getElementById('csv-root');
const isResxMode = (root?.dataset?.resx === '1');

// RESX-specific data
let resxColumns = [];
let resxDefaultValues = [];
let resxHasDefaultLocale = false;
try {
  const colScript = document.getElementById('__resxColumns');
  if (colScript) { resxColumns = JSON.parse(colScript.textContent || '[]'); }
  resxDefaultValues = root?.dataset?.defaultvalues ? JSON.parse(root.dataset.defaultvalues) : [];
  resxHasDefaultLocale = root?.dataset?.defaultlocale === '1';
} catch {}

const parsePositiveNumber = value => {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const configuredFontSizePx = parsePositiveNumber(root?.dataset?.fontsize);
const computedFontSizePx = parsePositiveNumber(window.getComputedStyle(document.body).fontSize);
const BASE_FONT_SIZE_PX = configuredFontSizePx ?? computedFontSizePx ?? 14;
const MOUSE_WHEEL_ZOOM_ENABLED = root?.dataset?.wheelzoomenabled !== '0';
const MOUSE_WHEEL_ZOOM_INVERTED = root?.dataset?.wheelzoominvert === '1';
const SINGLE_CLICK_EDIT = root?.dataset?.singleclickedit === '1';
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
let zoomScale = 1;
const getMinRowHeight = () => Math.max(22, Math.round(BASE_FONT_SIZE_PX * zoomScale * 1.6));

let lastContextIsHeader = false;
let isUpdating = false, isSelecting = false, anchorCell = null, rangeEndCell = null, currentSelection = [];
let startCell = null, endCell = null, selectionMode = "cell";
let editingCell = null, originalCellValue = "";
let editMode = null; // 'quick' | 'detail' | null
const DRAG_THRESHOLD_PX = 4;
const RESIZE_HANDLE_PX = 10;
const MIN_COL_WIDTH = 80;
const MIN_INDEX_COL_WIDTH = 30;
let resizeState = null;

const table = document.querySelector('#csv-root table');
const scrollContainer = document.querySelector('.table-container');
const contextMenu = document.getElementById('contextMenu');

let columnSizeState = {};
let rowSizeState = {};

const normalizeSizeState = (raw, minSize) => {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const idx = parseInt(k, 10);
    const size = Number(v);
    if (!Number.isFinite(idx) || idx < 0) continue;
    if (!Number.isFinite(size) || size < minSize) continue;
    out[String(idx)] = Math.round(size);
  }
  return out;
};

const applySizeStateToRenderedCells = () => {
  for (const [col, width] of Object.entries(columnSizeState)) {
    const minW = col === '0' ? MIN_INDEX_COL_WIDTH : MIN_COL_WIDTH;
    const px = Math.max(minW, Math.round(Number(width)));
    table.querySelectorAll(`[data-col="${col}"]`).forEach(cell => {
      cell.style.width = `${px}px`;
      cell.style.minWidth = `${px}px`;
      cell.style.maxWidth = `${px}px`;
    });
  }
  for (const [row, height] of Object.entries(rowSizeState)) {
    const px = Math.max(getMinRowHeight(), Math.round(Number(height)));
    table.querySelectorAll(`[data-row="${row}"]`).forEach(cell => {
      cell.style.height = `${px}px`;
      cell.style.minHeight = `${px}px`;
    });
  }
};

// ── Zoom ───────────────────────────────────────────────────────────

const setZoomScale = (nextScale, persist = true) => {
  const normalized = clamp(Math.round(nextScale * 100) / 100, ZOOM_MIN, ZOOM_MAX);
  if (Math.abs(normalized - zoomScale) < 0.001) return false;
  zoomScale = normalized;
  document.body.style.fontSize = `${Math.max(1, BASE_FONT_SIZE_PX * zoomScale)}px`;
  applySizeStateToRenderedCells();
  if (persist) persistState();
  return true;
};
const zoomIn = () => setZoomScale(zoomScale + ZOOM_STEP);
const zoomOut = () => setZoomScale(zoomScale - ZOOM_STEP);
const resetZoom = () => setZoomScale(1);
const isZoomModifier = e => (e.ctrlKey || e.metaKey) && !e.altKey;
const isZoomInShortcut = e => e.code === 'NumpadAdd' || e.key === '+' || e.key === '=';
const isZoomOutShortcut = e => e.code === 'NumpadSubtract' || e.key === '-' || e.key === '_';
const isZoomResetShortcut = e => e.key === '0';
const maybeHandleZoomShortcut = e => {
  if (!isZoomModifier(e)) return false;
  if (isZoomInShortcut(e)) { e.preventDefault(); zoomIn(); return true; }
  if (isZoomOutShortcut(e)) { e.preventDefault(); zoomOut(); return true; }
  if (isZoomResetShortcut(e)) { e.preventDefault(); resetZoom(); return true; }
  return false;
};

// ── State persistence ──────────────────────────────────────────────

const persistState = () => {
  try {
    const st = vscode.getState() || {};
    const anchor = anchorCell ? getCellCoords(anchorCell) : null;
    const nextState = {
      ...st,
      scrollX: scrollContainer ? scrollContainer.scrollLeft : 0,
      scrollY: scrollContainer ? scrollContainer.scrollTop : (window.scrollY || window.pageYOffset || 0),
      anchorRow: anchor ? anchor.row : undefined,
      anchorCol: anchor ? anchor.col : undefined,
      columnSizes: { ...columnSizeState },
      rowSizes: { ...rowSizeState },
      zoomScale
    };
    vscode.setState(nextState);
  } catch {}
};

const restoreState = () => {
  try {
    const st = vscode.getState() || {};
    const restoredZoom = parsePositiveNumber(st.zoomScale);
    setZoomScale(restoredZoom ?? 1, false);
    columnSizeState = normalizeSizeState(st.columnSizes, 40);
    rowSizeState = normalizeSizeState(st.rowSizes, getMinRowHeight());
    applySizeStateToRenderedCells();
    if (typeof st.scrollX === 'number' && scrollContainer) scrollContainer.scrollLeft = st.scrollX;
    if (typeof st.scrollY === 'number') {
      if (scrollContainer) scrollContainer.scrollTop = st.scrollY;
      else window.scrollTo(0, st.scrollY);
    }
    if (typeof st.anchorRow === 'number' && typeof st.anchorCol === 'number') {
      const tag = 'td';
      const sel = table.querySelector(`${tag}[data-row="${st.anchorRow}"][data-col="${st.anchorCol}"]`);
      if (sel) {
        clearSelection();
        sel.classList.add('selected');
        currentSelection.push(sel);
        anchorCell = sel; rangeEndCell = sel;
        try { sel.focus({ preventScroll: true }); } catch { try { sel.focus(); } catch {} }
      }
    }
    if (typeof st.scrollY === 'number' && scrollContainer) scrollContainer.scrollTop = st.scrollY;
  } catch {}
};

// ── Toolbar buttons ────────────────────────────────────────────────

document.getElementById('viewModeBtn')?.addEventListener('click', () => {
  const btn = document.getElementById('viewModeBtn');
  const isSingle = btn?.textContent?.includes('Multi');
  const mode = isSingle ? 'multi' : 'single';
  vscode.postMessage({ type: 'setViewMode', mode });
});

document.getElementById('openAsTextBtn')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'openAsText' });
});

// End toolbar buttons ──────────────────────────────────────────────

restoreState();
setTimeout(() => { try { restoreState(); } catch {} }, 0);
requestAnimationFrame(() => { try { restoreState(); } catch {} });

if (scrollContainer) {
  scrollContainer.addEventListener('scroll', () => persistState(), { passive: true });
} else {
  window.addEventListener('scroll', () => persistState(), { passive: true });
}
window.addEventListener('blur', () => persistState(), { passive: true });
window.addEventListener('focus', () => setTimeout(() => { try { restoreState(); } catch {} }, 0), { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistState();
  else setTimeout(() => { try { restoreState(); } catch {} }, 0);
});

// ── Zoom wheel handler ─────────────────────────────────────────────

window.addEventListener('wheel', e => {
  if (!MOUSE_WHEEL_ZOOM_ENABLED || !isZoomModifier(e) || Math.abs(e.deltaY) < 0.1) return;
  e.preventDefault();
  const naturalDirection = e.deltaY < 0 ? 1 : -1;
  const direction = MOUSE_WHEEL_ZOOM_INVERTED ? -naturalDirection : naturalDirection;
  direction > 0 ? zoomIn() : zoomOut();
}, { passive: false });

// ── Selection helpers ──────────────────────────────────────────────

const hasHeader = document.querySelector('thead') !== null;
const getCellCoords = cell => ({
  row: parseInt(cell.getAttribute('data-row')),
  col: parseInt(cell.getAttribute('data-col'))
});
const clearSelection = () => {
  currentSelection.forEach(c => c.classList.remove('selected'));
  currentSelection = [];
};

const getCellTarget = target => {
  const el = (target instanceof Element) ? target : (target instanceof Node ? target.parentElement : null);
  return el ? el.closest('td, th') : null;
};
const isColumnHeaderCell = cell => cell && cell.tagName === 'TH' && cell.getAttribute('data-col') !== '-1' && cell.getAttribute('data-col') !== null;
const isRowIndexCell = cell => cell && cell.getAttribute && cell.getAttribute('data-col') === '-1';

const getSelectedRowIds = () => {
  const ids = currentSelection
    .filter(el => isRowIndexCell(el))
    .map(el => parseInt(el.getAttribute('data-row') || 'NaN', 10))
    .filter(v => !Number.isNaN(v) && v >= 0);
  return Array.from(new Set(ids)).sort((a, b) => a - b);
};

// ── RESX missing-translation highlighting ──────────────────────────

const isMissingTranslation = (row, col) => {
  if (!isResxMode || !resxHasDefaultLocale) return false;
  const colInfo = resxColumns[col];
  if (!colInfo || colInfo.kind !== 'locale' || colInfo.locale === null) return false;
  const defaultValue = resxDefaultValues[row] ?? '';
  const cellEl = table.querySelector(`td[data-row="${row}"][data-col="${col}"]`);
  if (!cellEl) return false;
  const cellValue = cellEl.textContent || '';
  return !cellValue || cellValue === defaultValue;
};

const updateMissingHighlight = (cell, row, col) => {
  if (!isResxMode) return;
  if (isMissingTranslation(row, col)) {
    cell.classList.add('missing-translation');
  } else {
    cell.classList.remove('missing-translation');
  }
};

// ── Context menu ───────────────────────────────────────────────────

const showContextMenu = (x, y, row, col) => {
  contextMenu.innerHTML = '';
  const item = (label, cb) => {
    const d = document.createElement('div');
    d.textContent = label;
    d.addEventListener('click', () => { cb(); contextMenu.style.display = 'none'; });
    contextMenu.appendChild(d);
  };
  const divider = () => {
    const d = document.createElement('div');
    d.style.borderTop = '1px solid #888';
    d.style.margin = '1px 0';
    contextMenu.appendChild(d);
  };

  const selectedRowIds = getSelectedRowIds();
  const rowCountSel = selectedRowIds.length;

  if (lastContextIsHeader) {
    if (isResxMode) {
      item('Sort: A-Z', () =>
        vscode.postMessage({ type: 'sortRows', ascending: true, row: -1, col: -1, value: '' }));
      item('Sort: Z-A', () =>
        vscode.postMessage({ type: 'sortRows', ascending: false, row: -1, col: -1, value: '' }));
    }
  }

  if (!isNaN(row) && row >= 0) {
    if (contextMenu.children.length) divider();
    const rowsN = rowCountSel > 1 ? rowCountSel : 1;
    const addBelowLabel = rowsN > 1 ? `Add ${rowsN} ROWS below` : 'Add ROW below';
    const delLabel = rowsN > 1 ? `Delete ${rowsN} ROWS` : 'Delete ROW';
    item(addBelowLabel, () => {
      if (isResxMode) {
        const base = rowCountSel > 1 ? Math.max(...selectedRowIds) + 1 : (row + 1);
        vscode.postMessage({ type: 'insertRow', index: base, row: -1, col: -1, value: '' });
        vscode.postMessage({ type: 'insertRow', index: base, row: -1, col: -1, value: '' });
      } else {
        const base = rowCountSel > 1 ? Math.max(...selectedRowIds) + 1 : (row + 1);
        const count = rowsN;
        vscode.postMessage({ type: 'insertRows', index: base, count });
      }
    });
    item(delLabel, () => {
      if (isResxMode) {
        if (rowCountSel > 1) {
          vscode.postMessage({ type: 'deleteRows', indices: selectedRowIds, row: -1, col: -1, value: '' });
        } else {
          vscode.postMessage({ type: 'deleteRows', indices: [row], row: -1, col: -1, value: '' });
        }
      } else {
        if (rowCountSel > 1) {
          vscode.postMessage({ type: 'deleteRows', indices: selectedRowIds });
        } else {
          vscode.postMessage({ type: 'deleteRow', index: row });
        }
      }
    });

    if (isResxMode) {
      divider();
      item('Add new locale…', () => {
        vscode.postMessage({ type: 'addLocale', locale: '', row: -1, col: -1, value: '' });
      });
    }
  }

  if (!contextMenu.children.length) return;
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu.style.display = 'block';
};

// ── Selection engine ───────────────────────────────────────────────

const selectCell = (cell, extend = false) => {
  if (!cell) return;
  if (editingCell && editingCell !== cell) commitEdit();
  const { row, col } = getCellCoords(cell);
  if (isRowIndexCell(cell) || (hasHeader && isColumnHeaderCell(cell))) return; // skip index/header cells

  if (extend && anchorCell) {
    rangeEndCell = cell;
    const a = getCellCoords(anchorCell);
    const e = getCellCoords(rangeEndCell);
    clearSelection();
    const minR = Math.min(a.row, e.row), maxR = Math.max(a.row, e.row);
    const minC = Math.min(a.col, e.col), maxC = Math.max(a.col, e.col);
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const el = table.querySelector(`td[data-row="${r}"][data-col="${c}"]`);
        if (el) { el.classList.add('selected'); currentSelection.push(el); }
      }
    }
  } else {
    clearSelection();
    cell.classList.add('selected');
    currentSelection = [cell];
    anchorCell = cell;
    rangeEndCell = cell;
  }
  editingCell = null;
  editMode = null;
};

// ── Edit engine ────────────────────────────────────────────────────

const commitEdit = () => {
  if (!editingCell) return;
  const { row, col } = getCellCoords(editingCell);
  const value = editingCell.textContent || '';
  editingCell.classList.remove('editing');
  editingCell.contentEditable = 'false';
  updateMissingHighlight(editingCell, row, col);
  if (value !== originalCellValue) {
    if (isResxMode) {
      // Override to be replaced by host message
      editingCell.textContent = value;
    }
    vscode.postMessage({ type: 'editCell', row, col, value });
  }
  editingCell = null;
  editMode = null;
};

const enterEditMode = (cell, mode) => {
  if (!cell) return;
  const { row, col } = getCellCoords(cell);
  if (isRowIndexCell(cell) || isColumnHeaderCell(cell)) return;

  if (editingCell && editingCell !== cell) commitEdit();

  editingCell = cell;
  editMode = mode;
  originalCellValue = cell.textContent || '';
  cell.classList.add('editing');
  cell.contentEditable = 'true';
  cell.focus();
  // Place caret at end of content (deferred to avoid browser overriding)
  if (mode === 'quick' || mode === 'detail') {
    setTimeout(() => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }, 0);
  }
};

// ── Mouse handlers ─────────────────────────────────────────────────

let mouseDownPos = null;
let isDragging = false;
let isResizing = false;

// ── Column resize (header drag) ───────────────────────────────────

const getThResizeInfo = (th) => {
  return { col: parseInt(th.getAttribute('data-col'), 10), width: th.offsetWidth };
};

table?.addEventListener('mousemove', e => {
  if (isResizing) return;
  if (resizeState) return;
  const th = (e.target instanceof Element) ? e.target.closest('th') : null;
  if (!th) { table.style.cursor = ''; return; }
  const info = getThResizeInfo(th);
  if (info.col < 0) { table.style.cursor = ''; return; }
  const distFromRight = th.offsetWidth - e.offsetX;
  table.style.cursor = (distFromRight >= 0 && distFromRight <= RESIZE_HANDLE_PX) ? 'col-resize' : '';
});

const handleResizeStart = (e) => {
  const th = (e.target instanceof Element) ? e.target.closest('th') : null;
  if (!th) return false;
  const info = getThResizeInfo(th);
  if (info.col < 0) return false;
  const distFromRight = th.offsetWidth - e.offsetX;
  if (distFromRight < 0 || distFromRight > RESIZE_HANDLE_PX) return false;
  const minW = info.col === 0 ? MIN_INDEX_COL_WIDTH : MIN_COL_WIDTH;
  resizeState = { col: info.col, startX: e.clientX, startWidth: Math.max(minW, info.width), minW };
  isResizing = true;
  document.body.style.cursor = 'col-resize';
  e.preventDefault();
  return true;
};

const handleResizeMove = (e) => {
  if (!resizeState) return;
  const dx = e.clientX - resizeState.startX;
  const newWidth = Math.max(resizeState.minW, resizeState.startWidth + dx);
  const px = `${Math.round(newWidth)}px`;
  table.querySelectorAll(`[data-col="${resizeState.col}"]`).forEach(cell => {
    cell.style.width = px;
    cell.style.minWidth = px;
    cell.style.maxWidth = px;
  });
};

const handleResizeEnd = () => {
  if (!resizeState) return;
  const col = resizeState.col;
  // Read final width from a th element for the column
  const th = table.querySelector(`th[data-col="${col}"]`);
  const finalWidth = th ? Math.round(th.getBoundingClientRect().width) : Math.round(resizeState.startWidth);
  columnSizeState[String(col)] = Math.max(resizeState.minW, finalWidth);
  resizeState = null;
  isResizing = false;
  document.body.style.cursor = '';
  table.style.cursor = '';
  persistState();
};

// Override mousedown on th to intercept column resize
table?.addEventListener('mousedown', e => {
  if (e.button === 0 && handleResizeStart(e)) return;
});

document.addEventListener('mousemove', e => {
  if (isResizing) { handleResizeMove(e); return; }
});

document.addEventListener('mouseup', e => {
  if (isResizing) { handleResizeEnd(); return; }
});

// End column resize ────────────────────────────────────────────────

table?.addEventListener('mousedown', e => {
  if (isResizing) return;
  hideContextMenu();
  const cell = getCellTarget(e.target);
  if (!cell) return;

  lastContextIsHeader = isColumnHeaderCell(cell);
  const { row, col } = getCellCoords(cell);

  if (e.button === 2) {
    // right-click: select cell + show menu
    selectCell(cell, false);
    showContextMenu(e.clientX, e.clientY, row, col);
    return;
  }

  if (e.button !== 0) return;
  if (isColumnHeaderCell(cell) || isRowIndexCell(cell)) return;

  mouseDownPos = { x: e.clientX, y: e.clientY };
  isDragging = false;
  startCell = cell;
  endCell = null;
  selectionMode = e.shiftKey ? "extend" : "cell";
});

document.addEventListener('mousemove', e => {
  if (!mouseDownPos) return;
  const dx = e.clientX - mouseDownPos.x;
  const dy = e.clientY - mouseDownPos.y;
  if (!isDragging && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD_PX) {
    isDragging = true;
    isSelecting = true;
  }
  if (isSelecting) {
    const target = getCellTarget(e.target);
    if (target && !isRowIndexCell(target)) {
      endCell = target;
    }
  }
});

document.addEventListener('mouseup', e => {
  if (mouseDownPos && !isDragging && startCell && !isColumnHeaderCell(startCell)) {
    if (selectionMode === "extend") {
      selectCell(startCell, true);
    } else {
      selectCell(startCell, false);
      if (SINGLE_CLICK_EDIT) enterEditMode(startCell, 'quick');
    }
  } else if (mouseDownPos && isDragging) {
    const a = startCell;
    const b = endCell;
    if (a && b) {
      clearSelection();
      const ac = getCellCoords(a);
      const bc = getCellCoords(b);
      const minR = Math.min(ac.row, bc.row), maxR = Math.max(ac.row, bc.row);
      const minC = Math.min(ac.col, bc.col), maxC = Math.max(ac.col, bc.col);
      anchorCell = a;
      rangeEndCell = b;
      for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
          const el = table.querySelector(`td[data-row="${r}"][data-col="${c}"]`);
          if (el) { el.classList.add('selected'); currentSelection.push(el); }
        }
      }
    }
  }
  mouseDownPos = null;
  isDragging = false;
  isSelecting = false;
  startCell = null;
  endCell = null;
  selectionMode = "cell";
});

// Handle double-click → detail edit
table?.addEventListener('dblclick', e => {
  const cell = getCellTarget(e.target);
  if (cell && !isRowIndexCell(cell)) {
    enterEditMode(cell, 'detail');
  }
});

document.addEventListener('mousedown', e => {
  if (!contextMenu.contains(e.target)) hideContextMenu();
});

const hideContextMenu = () => { contextMenu.style.display = 'none'; };

// ── Keyboard handlers ──────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (maybeHandleZoomShortcut(e)) return;

  // Ctrl/Cmd+A → Select All
  if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !editingCell) {
    e.preventDefault();
    clearSelection();
    table.querySelectorAll('tbody td').forEach(td => {
      if (!isRowIndexCell(td)) {
        td.classList.add('selected');
        currentSelection.push(td);
      }
    });
    return;
  }

  // Ctrl/Cmd+C → Copy
  if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
    e.preventDefault();
    copySelection();
    return;
  }

  // Ctrl/Cmd+V → handled by default browser paste in edit mode
  // (no special handling needed)

  // Ctrl/Cmd+F → Find
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    openFind();
    return;
  }

  // Ctrl/Cmd+H → Replace
  if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
    e.preventDefault();
    openFindReplace();
    return;
  }

  // Escape → close find/replace or cancel edit
  if (e.key === 'Escape') {
    if (findWidget && findWidget.classList.contains('open')) {
      closeFind();
      return;
    }
    if (editingCell) {
      editingCell.textContent = originalCellValue;
      editingCell.classList.remove('editing');
      editingCell.contentEditable = 'false';
      editingCell = null;
      editMode = null;
      return;
    }
    clearSelection();
    return;
  }

  // Handle editing mode keys
  if (editingCell) {
    if (editMode === 'detail') {
      // Detail mode: Arrow keys move caret within cell
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        commitEdit();
        navigateCell('up');
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        commitEdit();
        navigateCell('down');
        return;
      }
      // Shift+Enter for newline in cell
      if (e.key === 'Enter' && e.shiftKey) return; // allow default
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitEdit();
        navigateCell('down');
        return;
      }
      // ArrowLeft/Right move caret (default behavior)
      return;
    }

    // Quick mode
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
      navigateCell('down');
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      commitEdit();
      navigateCell(e.shiftKey ? 'left' : 'right');
      return;
    }
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      commitEdit();
      navigateCell(e.key.replace('Arrow', '').toLowerCase());
      return;
    }
    return;
  }

  // Not editing — navigation
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    navigateCell(e.key.replace('Arrow', '').toLowerCase());
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (currentSelection.length === 1) {
      enterEditMode(currentSelection[0], 'detail');
    }
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    navigateCell(e.shiftKey ? 'left' : 'right');
    return;
  }

  // F3 / Shift+F3 → next/prev find match
  if (e.key === 'F3') {
    e.preventDefault();
    if (e.shiftKey) navigateFindMatch(-1); else navigateFindMatch(1);
    return;
  }

  // Any other printable character → quick edit
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (currentSelection.length === 1) {
      const cell = currentSelection[0];
      if (!isRowIndexCell(cell)) {
        enterEditMode(cell, 'quick');
        // Clear existing content and insert the typed character
        cell.textContent = e.key;
      }
    }
  }
});

// ── Navigation ─────────────────────────────────────────────────────

const navigateCell = (direction) => {
  if (currentSelection.length === 0) return;
  const last = currentSelection[currentSelection.length - 1];
  const { row, col } = getCellCoords(last);

  let targetRow = row, targetCol = col;
  switch (direction) {
    case 'up': targetRow--; break;
    case 'down': targetRow++; break;
    case 'left': targetCol--; break;
    case 'right': targetCol++; break;
  }

  // Wrap around for tab navigation
  if (direction === 'left' || direction === 'right') {
    // Use the first data row to determine the actual visible column range
    const firstRow = table.querySelector('tbody tr');
    const allCells = firstRow ? firstRow.querySelectorAll('td') : [];
    let maxCol = 0;
    allCells.forEach(cell => {
      const c = parseInt(cell.getAttribute('data-col'), 10);
      if (!isNaN(c) && c > maxCol) maxCol = c;
    });
    if (targetCol < 0) { targetRow--; targetCol = maxCol; }
    if (targetCol > maxCol) { targetRow++; targetCol = 0; }
  }

  const target = table.querySelector(`td[data-row="${targetRow}"][data-col="${targetCol}"]`);
  if (target && !isRowIndexCell(target)) {
    selectCell(target, false);
    try { target.focus({ preventScroll: false }); } catch {}
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
};

// ── Copy ───────────────────────────────────────────────────────────

const copySelection = () => {
  if (!currentSelection.length) return;
  const cells = currentSelection
    .filter(el => !isRowIndexCell(el))
    .map(el => ({ ...getCellCoords(el), text: el.textContent || '' }))
    .sort((a, b) => a.row - b.row || a.col - b.col);

  if (!cells.length) return;
  const minR = cells[0].row, maxR = cells[cells.length - 1].row;
  const minC = Math.min(...cells.map(c => c.col));
  const maxC = Math.max(...cells.map(c => c.col));

  let text = '';
  for (let r = minR; r <= maxR; r++) {
    const rowCells = cells.filter(c => c.row === r);
    const parts = [];
    for (let c = minC; c <= maxC; c++) {
      const cell = rowCells.find(cc => cc.col === c);
      parts.push(cell ? cell.text : '');
    }
    text += parts.join('\t');
    if (r < maxR) text += '\n';
  }

  vscode.postMessage({ type: 'copyToClipboard', text });
};

// ── Find & Replace ─────────────────────────────────────────────────

let findRequestId = 0;
let findMatches = [];
let findMatchIndex = -1;
let findRegex = false;
let findWholeWord = false;
let findMatchCase = false;

const findWidget = document.getElementById('findReplaceWidget');
const findInput = document.getElementById('findInput');
const findStatus = document.getElementById('findStatus');
const findNextBtn = document.getElementById('findNext');
const findPrevBtn = document.getElementById('findPrev');
const findCloseBtn = document.getElementById('findClose');
const findCaseToggle = document.getElementById('findCaseToggle');
const findWordToggle = document.getElementById('findWordToggle');
const findRegexToggle = document.getElementById('findRegexToggle');
const replaceToggle = document.getElementById('replaceToggle');
const replaceToggleGutter = document.getElementById('replaceToggleGutter');
const replaceInput = document.getElementById('replaceInput');
const replaceOneBtn = document.getElementById('replaceOne');
const replaceAllBtn = document.getElementById('replaceAll');

const clearFindHighlights = () => {
  table.querySelectorAll('.highlight, .active-match').forEach(el => {
    el.classList.remove('highlight', 'active-match');
  });
};

const highlightMatch = (row, col) => {
  const el = table.querySelector(`td[data-row="${row}"][data-col="${col}"]`);
  if (el) el.classList.add('active-match');
};

const doFind = () => {
  clearFindHighlights();
  const query = findInput.value;
  if (!query) { findMatches = []; findMatchIndex = -1; updateFindUI(); return; }

  findRequestId++;
  vscode.postMessage({
    type: 'findMatches',
    requestId: findRequestId,
    query,
    options: { regex: findRegex, wholeWord: findWholeWord, matchCase: findMatchCase },
    row: -1, col: -1, value: ''
  });
};

const updateFindUI = () => {
  const total = findMatches.length;
  if (total === 0) {
    findStatus.textContent = 'No results';
    findNextBtn.disabled = true;
    findPrevBtn.disabled = true;
    replaceOneBtn.disabled = true;
    replaceAllBtn.disabled = true;
    return;
  }
  findStatus.textContent = `${findMatchIndex + 1} of ${total}`;
  findNextBtn.disabled = false;
  findPrevBtn.disabled = false;
  replaceOneBtn.disabled = false;
  replaceAllBtn.disabled = false;

  // Highlight active match
  clearFindHighlights();
  findMatches.forEach(m => {
    const el = table.querySelector(`td[data-row="${m.row}"][data-col="${m.col}"]`);
    if (el) el.classList.add('highlight');
  });
  if (findMatches[findMatchIndex]) {
    highlightMatch(findMatches[findMatchIndex].row, findMatches[findMatchIndex].col);
  }
};

const navigateFindMatch = (dir) => {
  if (!findMatches.length) return;
  findMatchIndex += dir;
  if (findMatchIndex >= findMatches.length) findMatchIndex = 0;
  if (findMatchIndex < 0) findMatchIndex = findMatches.length - 1;
  updateFindUI();

  const match = findMatches[findMatchIndex];
  if (match) {
    const el = table.querySelector(`td[data-row="${match.row}"][data-col="${match.col}"]`);
    if (el) {
      selectCell(el, false);
      el.scrollIntoView({ block: 'center', inline: 'center' });
    }
  }
};

const openFind = () => {
  if (!findWidget) return;
  findWidget.classList.remove('replace-collapsed');
  findWidget.classList.add('open');
  findInput.focus();
  findInput.select();
  if (findInput.value) doFind();
};

const openFindReplace = () => {
  openFind();
  if (!findWidget) return;
  findWidget.classList.remove('replace-collapsed');
  replaceToggle.setAttribute('aria-expanded', 'true');
};

const closeFind = () => {
  if (!findWidget) return;
  findWidget.classList.remove('open');
  clearFindHighlights();
  findMatches = [];
  findMatchIndex = -1;
};

findInput?.addEventListener('input', e => { e.stopPropagation(); doFind(); });
findInput?.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.shiftKey ? navigateFindMatch(-1) : navigateFindMatch(1); }
  if (e.key === 'Escape') closeFind();
});
findNextBtn?.addEventListener('click', () => navigateFindMatch(1));
findPrevBtn?.addEventListener('click', () => navigateFindMatch(-1));
findCloseBtn?.addEventListener('click', closeFind);
findCaseToggle?.addEventListener('click', () => {
  findMatchCase = !findMatchCase;
  findCaseToggle.setAttribute('aria-pressed', String(findMatchCase));
  doFind();
});
findWordToggle?.addEventListener('click', () => {
  findWholeWord = !findWholeWord;
  findWordToggle.setAttribute('aria-pressed', String(findWholeWord));
  doFind();
});
findRegexToggle?.addEventListener('click', () => {
  findRegex = !findRegex;
  findRegexToggle.setAttribute('aria-pressed', String(findRegex));
  doFind();
});
replaceToggle?.addEventListener('click', () => {
  const expanded = replaceToggle.getAttribute('aria-expanded') === 'true';
  replaceToggle.setAttribute('aria-expanded', String(!expanded));
  findWidget.classList.toggle('replace-collapsed');
});
replaceOneBtn?.addEventListener('click', () => {
  if (!findMatches[findMatchIndex]) return;
  const match = findMatches[findMatchIndex];
  const replaceValue = replaceInput.value;
  findRequestId++;
  vscode.postMessage({
    type: 'replaceMatches',
    requestId: findRequestId,
    replacements: [{ row: match.row, col: match.col, value: replaceValue }],
    row: -1, col: -1, value: ''
  });
  doFind(); // re-search
});
replaceAllBtn?.addEventListener('click', () => {
  if (!findMatches.length) return;
  const replaceValue = replaceInput.value;
  const replacements = findMatches.map(m => ({ row: m.row, col: m.col, value: replaceValue }));
  findRequestId++;
  vscode.postMessage({
    type: 'replaceMatches',
    requestId: findRequestId,
    replacements,
    row: -1, col: -1, value: ''
  });
  doFind();
});

// ── Host → Webview messages ───────────────────────────────────────

window.addEventListener('message', event => {
  const msg = event.data;
  switch (msg.type) {
    case 'focus':
      try { document.body.focus({ preventScroll: true }); } catch { try { document.body.focus(); } catch {} }
      break;
    case 'updateCell':
      {
        const el = table.querySelector(`td[data-row="${msg.row}"][data-col="${msg.col}"]`);
        if (el && !el.classList.contains('editing')) {
          el.textContent = msg.value;
          if (msg.missingClass) {
            el.classList.add(msg.missingClass.replace(' ', '.'));
          } else {
            el.classList.remove('missing-translation');
          }
        }
      }
      break;
    case 'findMatchesResult':
      if (msg.requestId === findRequestId) {
        findMatches = msg.matches || [];
        findMatchIndex = findMatches.length > 0 ? 0 : -1;
        updateFindUI();
      }
      break;
    case 'addLocale':
      // Host echoes back – just re-search
      break;
  }
});

// ── Initialize missing-translation highlights ──────────────────────

if (isResxMode) {
  table.querySelectorAll('td[data-row]').forEach(td => {
    const row = parseInt(td.getAttribute('data-row'));
    const col = parseInt(td.getAttribute('data-col'));
    updateMissingHighlight(td, row, col);
  });
}
