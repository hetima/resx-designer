// State management — zoom, column/row sizes, persistence.

import {
  vscode, table, scrollContainer,
  BASE_FONT_SIZE_PX, MIN_COL_WIDTH, MIN_INDEX_COL_WIDTH,
  MOUSE_WHEEL_ZOOM_ENABLED, MOUSE_WHEEL_ZOOM_INVERTED,
  clamp, parsePositiveNumber,
  getCellCoords,
} from './shared.js';

// ── Mutable state ─────────────────────────────────────────────────

const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;

let zoomScale = 1;
let columnSizeState = {};
let rowSizeState = {};

const getMinRowHeight = () => Math.max(22, Math.round(BASE_FONT_SIZE_PX * zoomScale * 1.6));

// Selection state (needed by persist/restore)
let anchorCell = null;
let rangeEndCell = null;
let currentSelection = [];

// ── Selection state accessors (set by selection.js) ────────────────

/** Called by selection.js to sync refs for state persistence */
const setSelectionRefs = (getAnchor, getRangeEnd, getCurrentSelection) => {
  // We use getter functions to avoid circular module initialization
  // The actual assignment is deferred via these accessors in persistState/restoreState
  _getAnchor = getAnchor;
  _getRangeEnd = getRangeEnd;
  _getCurrentSelection = getCurrentSelection;
};

let _getAnchor = () => anchorCell;
let _getRangeEnd = () => rangeEndCell;
let _getCurrentSelection = () => currentSelection;

/** Set clearSelection callback from selection.js */
let _clearSelection = null;
const setClearSelection = (fn) => { _clearSelection = fn; };

// ── Size state ────────────────────────────────────────────────────

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
    const anchor = _getAnchor();
    const coords = anchor ? getCellCoords(anchor) : null;
    const nextState = {
      ...st,
      scrollX: scrollContainer ? scrollContainer.scrollLeft : 0,
      scrollY: scrollContainer ? scrollContainer.scrollTop : (window.scrollY || window.pageYOffset || 0),
      anchorRow: coords ? coords.row : undefined,
      anchorCol: coords ? coords.col : undefined,
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
      const sel = table.querySelector(`td[data-row="${st.anchorRow}"][data-col="${st.anchorCol}"]`);
      if (sel && _clearSelection) {
        _clearSelection();
        sel.classList.add('selected');
        _getCurrentSelection().push(sel);
        anchorCell = sel; rangeEndCell = sel;
        try { sel.focus({ preventScroll: true }); } catch { try { sel.focus(); } catch {} }
      }
    }
    if (typeof st.scrollY === 'number' && scrollContainer) scrollContainer.scrollTop = st.scrollY;
  } catch {}
};

// ── Resize state (shared with mouse.js) ───────────────────────────

let resizeState = null;
let isResizing = false;

const getResizeState = () => resizeState;
const setResizeState = (val) => { resizeState = val; };
const getIsResizing = () => isResizing;
const setIsResizing = (val) => { isResizing = val; };
const updateColumnSizeState = (col, width) => { columnSizeState[String(col)] = Math.max(MIN_INDEX_COL_WIDTH, width); };

// ── clearState message handler ─────────────────────────────────────
const handleClearState = () => {
  columnSizeState = {};
  rowSizeState = {};
  zoomScale = 1;
  document.body.style.fontSize = `${Math.max(1, BASE_FONT_SIZE_PX * zoomScale)}px`;
  try { vscode.setState({}); } catch {}
};

export {
  // Zoom
  zoomScale,
  setZoomScale, zoomIn, zoomOut, resetZoom,
  isZoomModifier, isZoomInShortcut, isZoomOutShortcut, isZoomResetShortcut,
  maybeHandleZoomShortcut,
  // Sizes
  getMinRowHeight,
  columnSizeState, rowSizeState,
  normalizeSizeState, applySizeStateToRenderedCells,
  // Persistence
  persistState, restoreState,
  setSelectionRefs, setClearSelection,
  // Resize
  resizeState, getResizeState, setResizeState,
  isResizing, getIsResizing, setIsResizing,
  updateColumnSizeState,
  // clearState
  handleClearState,
};
