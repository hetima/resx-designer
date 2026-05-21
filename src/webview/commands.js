// Keyboard handlers — shortcuts, navigation, editing keys.

import {
  vscode, table,
  scrollContainer,
} from './shared.js';
import { maybeHandleZoomShortcut } from './state.js';
import {
  clearSelection, selectCell, commitEdit, enterEditMode,
  navigateCell, copySelection,
  currentSelection,
  getEditingCell, setEditingCell,
  getEditMode, setEditMode,
  getOriginalCellValue,
  isRowIndexCell, isActionCell,
} from './selection.js';
import {
  getCellTarget, isColumnHeaderCell,
  isRowIndexCell as _isRowIndexCell,
  isActionCell as _isActionCell,
} from './shared.js';
import { openFind, closeFind, navigateFindMatch, findWidget } from './find.js';

document.addEventListener('keydown', e => {
  if (maybeHandleZoomShortcut(e)) return;

  // Ctrl/Cmd+A → Select All
  if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !getEditingCell()) {
    e.preventDefault();
    clearSelection();
    table.querySelectorAll('tbody td').forEach(td => {
      if (!_isRowIndexCell(td) && !_isActionCell(td)) {
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

  // Escape → close find or cancel edit
  if (e.key === 'Escape') {
    if (findWidget && findWidget.classList.contains('open')) {
      closeFind();
      return;
    }
    if (getEditingCell()) {
      const ec = getEditingCell();
      ec.textContent = getOriginalCellValue();
      ec.classList.remove('editing');
      ec.contentEditable = 'false';
      setEditingCell(null);
      setEditMode(null);
      return;
    }
    clearSelection();
    return;
  }

  // Handle editing mode keys
  if (getEditingCell()) {
    if (getEditMode() === 'detail') {
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

  // PageUp / PageDown / Home / End → scroll the table
  if (e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') {
    if (scrollContainer) {
      e.preventDefault();
      const pageSize = scrollContainer.clientHeight;
      switch (e.key) {
        case 'PageUp':
          scrollContainer.scrollTop -= pageSize;
          break;
        case 'PageDown':
          scrollContainer.scrollTop += pageSize;
          break;
        case 'Home':
          scrollContainer.scrollTop = 0;
          break;
        case 'End':
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
          break;
      }
    }
    return;
  }

  // Any other printable character → quick edit
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (currentSelection.length === 1) {
      const cell = currentSelection[0];
      if (!_isRowIndexCell(cell) && !_isActionCell(cell)) {
        enterEditMode(cell, 'quick');
        // Clear existing content and insert the typed character
        cell.textContent = e.key;
      }
    }
  }
});
