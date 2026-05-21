// Selection engine and edit engine.

import {
  vscode, table, isResxMode,
  resxColumns, resxDefaultValues, resxHasDefaultLocale,
  getCellCoords, getCellTarget,
  isColumnHeaderCell, isRowIndexCell, isActionCell,
} from './shared.js';
import { setSelectionRefs, setClearSelection } from './state.js';

// ── Mutable selection state ────────────────────────────────────────

let isSelecting = false;
let anchorCell = null;
let rangeEndCell = null;
let currentSelection = [];
let startCell = null;
let endCell = null;
let selectionMode = "cell";

// Edit state
let _editingCell = null;
let _originalCellValue = "";
let _editMode = null; // 'quick' | 'detail' | null

// Accessors for mutable edit state
const getEditingCell = () => _editingCell;
const setEditingCell = (v) => { _editingCell = v; };
const getOriginalCellValue = () => _originalCellValue;
const setOriginalCellValue = (v) => { _originalCellValue = v; };
const getEditMode = () => _editMode;
const setEditMode = (v) => { _editMode = v; };

// Register selection refs with state module for persistence
setSelectionRefs(
  () => anchorCell,
  () => rangeEndCell,
  () => currentSelection
);
setClearSelection(clearSelection);

// ── Selection helpers ─────────────────────────────────────────────

const clearSelection = () => {
  currentSelection.forEach(c => c.classList.remove('selected'));
  currentSelection = [];
};

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
  // name-col の missing-translation はホスト側が付与するので触らない
  if (cell.classList.contains('name-col')) return;
  if (isMissingTranslation(row, col)) {
    cell.classList.add('missing-translation');
  } else {
    cell.classList.remove('missing-translation');
  }
};

// ── Selection engine ───────────────────────────────────────────────

const selectCell = (cell, extend = false) => {
  if (!cell) return;
  if (_editingCell && _editingCell !== cell) commitEdit();
  const { row, col } = getCellCoords(cell);
  if (isRowIndexCell(cell) || isActionCell(cell) || isColumnHeaderCell(cell)) return;

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
  setEditingCell(null);
  setEditMode(null);
};

// ── Edit engine ────────────────────────────────────────────────────

const commitEdit = () => {
  if (!_editingCell) return;
  const { row, col } = getCellCoords(_editingCell);
  const value = _editingCell.textContent || '';
  _editingCell.classList.remove('editing');
  _editingCell.contentEditable = 'false';
  updateMissingHighlight(_editingCell, row, col);
  if (value !== _originalCellValue) {
    if (isResxMode) {
      _editingCell.textContent = value;
    }
    vscode.postMessage({ type: 'editCell', row, col, value });
  }
  setEditingCell(null);
  setEditMode(null);
};

const enterEditMode = (cell, mode) => {
  if (!cell) return;
  const { row, col } = getCellCoords(cell);
  if (isRowIndexCell(cell) || isActionCell(cell) || isColumnHeaderCell(cell)) return;
  if (cell.hasAttribute('data-readonly')) return;

  if (_editingCell && _editingCell !== cell) commitEdit();

  setEditingCell(cell);
  setEditMode(mode);
  setOriginalCellValue(cell.textContent || '');
  cell.classList.add('editing');
  cell.contentEditable = 'true';
  cell.focus();
};

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
  if (target && !isRowIndexCell(target) && !isActionCell(target)) {
    selectCell(target, false);
    try { target.focus({ preventScroll: false }); } catch {}
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
};

// ── Copy ───────────────────────────────────────────────────────────

const copySelection = () => {
  if (!currentSelection.length) return;
  const cells = currentSelection
    .filter(el => !isRowIndexCell(el) && !isActionCell(el))
    .map(el => ({ ...getCellCoords(el), text: el.textContent || '' }))
    .sort((a, b) => a.row - b.row || a.col - b.col);

  if (!cells.length) return;
  const minR = cells[0].row, maxR = cells[cells.length - 1].row;
  const minC = Math.min(...cells.map(c => c.col));
  const maxC = Math.max(...cells.map(c => c.col));

  const csvEscape = (val) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
      return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  };

  let text = '';
  for (let r = minR; r <= maxR; r++) {
    const rowCells = cells.filter(c => c.row === r);
    const parts = [];
    for (let c = minC; c <= maxC; c++) {
      const cell = rowCells.find(cc => cc.col === c);
      parts.push(csvEscape(cell ? cell.text : ''));
    }
    text += parts.join(',');
    if (r < maxR) text += '\n';
  }

  vscode.postMessage({ type: 'copyToClipboard', text });
};

// ── Drag state accessors (for mouse.js) ───────────────────────────

const getIsSelecting = () => isSelecting;
const setIsSelecting = (val) => { isSelecting = val; };
const setStartCell = (val) => { startCell = val; };
const setEndCell = (val) => { endCell = val; };
const getStartCell = () => startCell;
const getEndCell = () => endCell;
const setSelectionMode = (val) => { selectionMode = val; };

export {
  // Selection state getters
  currentSelection,
  getEditingCell, setEditingCell,
  getEditMode, setEditMode,
  getOriginalCellValue, setOriginalCellValue,
  // Selection
  clearSelection, selectCell, getSelectedRowIds,
  // Edit
  commitEdit, enterEditMode,
  // Navigation
  navigateCell,
  // Copy
  copySelection,
  // Missing translation
  updateMissingHighlight,
  // Drag state
  isSelecting, getIsSelecting, setIsSelecting,
  startCell, endCell, selectionMode,
  setStartCell, setEndCell, getStartCell, getEndCell,
  setSelectionMode,
};
