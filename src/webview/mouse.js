// Mouse handlers — drag selection, column resize, action menu.

import {
  vscode, table,
  hasHeader,
  SINGLE_CLICK_EDIT,
  getCellCoords, getCellTarget,
  isColumnHeaderCell, isRowIndexCell, isActionCell,
  RESIZE_HANDLE_PX, MIN_COL_WIDTH, MIN_INDEX_COL_WIDTH,
  DRAG_THRESHOLD_PX,
} from './shared.js';
import {
  persistState,
  getResizeState, setResizeState,
  getIsResizing, setIsResizing,
  updateColumnSizeState, applySizeStateToRenderedCells,
} from './state.js';
import {
  selectCell, clearSelection, commitEdit, enterEditMode,
  setIsSelecting, setStartCell, setEndCell,
  getStartCell, getEndCell, setSelectionMode,
  currentSelection,
} from './selection.js';
import { openInsertKeyDialog, openDeleteKeyDialog } from './dialogs.js';

// ── Mouse drag state ───────────────────────────────────────────────

let mouseDownPos = null;
let isDragging = false;

// ── Column resize (header drag) ───────────────────────────────────

const getThResizeInfo = (th) => {
  return { col: parseInt(th.getAttribute('data-col'), 10), width: th.offsetWidth };
};

table?.addEventListener('mousemove', e => {
  if (getIsResizing()) return;
  if (getResizeState()) return;
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
  setResizeState({ col: info.col, startX: e.clientX, startWidth: Math.max(minW, info.width), minW });
  setIsResizing(true);
  document.body.style.cursor = 'col-resize';
  e.preventDefault();
  return true;
};

const handleResizeMove = (e) => {
  const rs = getResizeState();
  if (!rs) return;
  const dx = e.clientX - rs.startX;
  const newWidth = Math.max(rs.minW, rs.startWidth + dx);
  const px = `${Math.round(newWidth)}px`;
  table.querySelectorAll(`[data-col="${rs.col}"]`).forEach(cell => {
    cell.style.width = px;
    cell.style.minWidth = px;
    cell.style.maxWidth = px;
  });
};

const handleResizeEnd = () => {
  const rs = getResizeState();
  if (!rs) return;
  const col = rs.col;
  const th = table.querySelector(`th[data-col="${col}"]`);
  const finalWidth = th ? Math.round(th.getBoundingClientRect().width) : Math.round(rs.startWidth);
  updateColumnSizeState(col, Math.max(rs.minW, finalWidth));
  setResizeState(null);
  setIsResizing(false);
  document.body.style.cursor = '';
  table.style.cursor = '';
  persistState();
};

// Override mousedown on th to intercept column resize
table?.addEventListener('mousedown', e => {
  if (e.button === 0 && handleResizeStart(e)) return;
});

document.addEventListener('mousemove', e => {
  if (getIsResizing()) { handleResizeMove(e); return; }
});

document.addEventListener('mouseup', e => {
  if (getIsResizing()) { handleResizeEnd(); return; }
});

// End column resize ────────────────────────────────────────────────

// ── Cell drag selection ───────────────────────────────────────────

table?.addEventListener('mousedown', e => {
  if (getIsResizing()) return;
  const cell = getCellTarget(e.target);
  if (!cell) return;

  if (e.button !== 0) return;
  if (isColumnHeaderCell(cell) || isRowIndexCell(cell) || isActionCell(cell)) return;

  mouseDownPos = { x: e.clientX, y: e.clientY };
  isDragging = false;
  setStartCell(cell);
  setEndCell(null);
  setSelectionMode(e.shiftKey ? "extend" : "cell");
});

document.addEventListener('mousemove', e => {
  if (!mouseDownPos) return;
  const dx = e.clientX - mouseDownPos.x;
  const dy = e.clientY - mouseDownPos.y;
  if (!isDragging && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD_PX) {
    isDragging = true;
    setIsSelecting(true);
  }
  if (isDragging) {
    const target = getCellTarget(e.target);
    if (target && !isRowIndexCell(target) && !isActionCell(target)) {
      setEndCell(target);
    }
  }
});

document.addEventListener('mouseup', e => {
  const a = getStartCell();
  const b = getEndCell();
  if (mouseDownPos && !isDragging && a && !isColumnHeaderCell(a)) {
    // Read selectionMode from the module
    const sm = e.shiftKey ? "extend" : "cell";
    if (sm === "extend") {
      selectCell(a, true);
    } else {
      selectCell(a, false);
      if (SINGLE_CLICK_EDIT && a !== null) enterEditMode(a, 'quick');
    }
  } else if (mouseDownPos && isDragging && a && b) {
    clearSelection();
    const ac = getCellCoords(a);
    const bc = getCellCoords(b);
    const minR = Math.min(ac.row, bc.row), maxR = Math.max(ac.row, bc.row);
    const minC = Math.min(ac.col, bc.col), maxC = Math.max(ac.col, bc.col);
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const el = table.querySelector(`td[data-row="${r}"][data-col="${c}"]`);
        if (el) { el.classList.add('selected'); currentSelection.push(el); }
      }
    }
  }
  mouseDownPos = null;
  isDragging = false;
  setIsSelecting(false);
  setStartCell(null);
  setEndCell(null);
  setSelectionMode("cell");
});

table?.addEventListener('dblclick', e => {
  const cell = getCellTarget(e.target);
  if (cell && !isRowIndexCell(cell) && !isActionCell(cell)) {
    enterEditMode(cell, 'detail');
  }
});

// ── Action column context menu ────────────────────────────────────

let actionMenuEl = null;
let actionMenuOverlay = null;

const closeActionMenu = () => {
  if (actionMenuOverlay) { actionMenuOverlay.remove(); actionMenuOverlay = null; }
  if (actionMenuEl) { actionMenuEl.remove(); actionMenuEl = null; }
};

const openActionMenu = (cell, clientX, clientY) => {
  closeActionMenu();
  const name = cell.getAttribute('data-name') || '';

  actionMenuOverlay = document.createElement('div');
  actionMenuOverlay.className = 'action-menu-overlay';
  document.body.appendChild(actionMenuOverlay);

  actionMenuEl = document.createElement('div');
  actionMenuEl.className = 'action-menu';
  actionMenuEl.innerHTML = `
    <div class="action-menu-label" title="${name.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}">${name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
    <button class="action-menu-item" data-action="bulkEdit">Bulk Edit</button>
    <button class="action-menu-item" data-action="insertKeyBelow">Insert New Key Below</button>
    <button class="action-menu-item danger" data-action="deleteKey">Delete This Key…</button>
  `;
  document.body.appendChild(actionMenuEl);

  // Position: ensure it stays within viewport
  const rect = actionMenuEl.getBoundingClientRect();
  let x = clientX;
  let y = clientY;
  if (x + 200 > window.innerWidth) x = window.innerWidth - 210;
  if (y + rect.height > window.innerHeight) y = clientY - rect.height;
  actionMenuEl.style.left = x + 'px';
  actionMenuEl.style.top = y + 'px';

  // Menu item actions
  actionMenuEl.querySelectorAll('.action-menu-item[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const action = btn.getAttribute('data-action');
      const row = parseInt(cell.getAttribute('data-row') || '0', 10);
      if (action === 'bulkEdit') {
        vscode.postMessage({ type: 'bulkEdit', name });
      } else if (action === 'insertKeyBelow') {
        openInsertKeyDialog(name, row);
      } else if (action === 'deleteKey') {
        openDeleteKeyDialog(name);
      }
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
};

table?.addEventListener('click', e => {
  const cell = getCellTarget(e.target);
  if (!cell || !isActionCell(cell)) return;
  e.stopPropagation();
  openActionMenu(cell, e.clientX, e.clientY);
});

// Close menu on any other click outside
document.addEventListener('click', e => {
  if (actionMenuEl && !actionMenuEl.contains(e.target)) {
    closeActionMenu();
  }
});

export { closeActionMenu, openActionMenu };
