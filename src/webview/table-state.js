// Table state management — dirty tracking, change history, undo/redo.
//
// Provides `TableStateManager` which tracks changes to table data.
// The manager is initialized from the inline script (where `rows` and `columns` live)
// and exposed as `window.__tableStateManager` so bundled modules can access it.
//
// Change flow:
//   Inline script mutates rows → calls recordChange() → dirty + undo stack updated → host notified
// Undo flow:
//   commands.js catches Ctrl+Z → calls window.__tableStateManager.undo() → rows mutated → body re-rendered
// Save flow:
//   Host sends { type: 'resetSnapshot' } → index.js calls manager.takeSnapshot() → dirty cleared

// ── Snapshot helpers (pure functions — no module-level state) ──────

/** Clone a row object. Values Map is shallow-copied; menu/menuTitle are shared (read-only). */
function cloneRow(r) {
  return {
    name: r.name,
    comment: r.comment,
    values: new Map(r.values),
    menu: r.menu,
    menuTitle: r.menuTitle,
  };
}

/** Clone an entire rows array. */
function cloneRows(src) {
  return src.map(cloneRow);
}

/** Compare two row arrays for equality (name, comment, values — structural order-sensitive). */
function rowsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].comment !== b[i].comment) return false;
    if (a[i].values.size !== b[i].values.size) return false;
    for (const [k, v] of a[i].values) {
      if (b[i].values.get(k) !== v) return false;
    }
  }
  return true;
}

// ── TableStateManager ─────────────────────────────────────────────

export class TableStateManager {
  constructor() {
    this._snapshot = [];     // baseline rows (clean state)
    this._undoStack = [];
    this._redoStack = [];
    this._dirty = false;
    this._enabled = false;  // false until initTableState() is called
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * Initialize the manager with references to the live rows/columns arrays.
   * @param {Array} rows - The mutable rows array from inline script
   * @param {Array} columns - The columns descriptor array
   */
  initTableState(rows, columns) {
    this._rows = rows;
    this._columns = columns;
    this._enabled = true;
    this.takeSnapshot();
  }

  /** Take a baseline snapshot (call at init and after save). */
  takeSnapshot() {
    this._snapshot = cloneRows(this._rows);
    this._undoStack = [];
    this._redoStack = [];
    this._setDirty(false);
  }

  get isDirty() { return this._dirty; }
  get canUndo() { return this._undoStack.length > 0; }
  get canRedo() { return this._redoStack.length > 0; }
  get enabled() { return this._enabled; }

  // ── Change recording ───────────────────────────────────────────

  /**
   * Record a change. The caller must have already mutated `_rows`.
   * @param {Object} change - A change record with a `kind` field.
   *   Supported kinds: 'cell', 'addRow', 'deleteRow', 'deleteRows', 'sort', 'renameColumn'
   */
  recordChange(change) {
    if (!this._enabled) return;
    this._undoStack.push(change);
    this._redoStack = [];
    this._recalcDirty();
    this._notifyHost('tableEditDirty', { isDirty: this._dirty });
  }

  // ── Undo / Redo ──────────────────────────────────────────────

  /** Undo the most recent change. Returns true if undone. */
  undo() {
    if (!this._enabled || this._undoStack.length === 0) return false;
    const change = this._undoStack.pop();
    this._applyInverse(change);
    this._redoStack.push(change);
    this._recalcDirty();
    this._notifyHost('tableEditUndo', { isDirty: this._dirty });
    return true;
  }

  /** Redo the most recently undone change. Returns true if redone. */
  redo() {
    if (!this._enabled || this._redoStack.length === 0) return false;
    const change = this._redoStack.pop();
    this._applyChange(change);
    this._undoStack.push(change);
    this._recalcDirty();
    this._notifyHost('tableEditRedo', { isDirty: this._dirty });
    return true;
  }

  // ── Diff computation ──────────────────────────────────────────

  /** Return all cell-level changes vs the baseline snapshot. */
  getChanges() {
    if (!this._enabled) return [];
    const snap = this._snapshot;
    const cur = this._rows;
    const changes = [];

    if (snap.length !== cur.length) {
      return [{ kind: 'structural', snapshotRows: snap.length, currentRows: cur.length }];
    }

    for (let r = 0; r < cur.length; r++) {
      if (cur[r].name !== snap[r].name) {
        changes.push({ kind: 'cell', row: r, field: 'name', oldValue: snap[r].name, newValue: cur[r].name });
      }
      if (cur[r].comment !== snap[r].comment) {
        changes.push({ kind: 'cell', row: r, field: 'comment', oldValue: snap[r].comment, newValue: cur[r].comment });
      }
      const curVals = cur[r].values;
      const snapVals = snap[r].values;
      const allLocales = new Set([...curVals.keys(), ...snapVals.keys()]);
      for (const locale of allLocales) {
        const curV = curVals.get(locale) ?? '';
        const snapV = snapVals.get(locale) ?? '';
        if (curV !== snapV) {
          changes.push({ kind: 'cell', row: r, col: this._findColIndex(locale), locale, oldValue: snapV, newValue: curV });
        }
      }
    }
    return changes;
  }

  // ── Private ───────────────────────────────────────────────────

  _findColIndex(locale) {
    return this._columns.findIndex(c => c.kind === 'locale' && c.locale === locale);
  }

  _recalcDirty() {
    const newDirty = !rowsEqual(this._snapshot, this._rows);
    if (newDirty !== this._dirty) {
      this._dirty = newDirty;
    }
  }

  _setDirty(v) {
    this._dirty = v;
    this._notifyHost('tableEditDirty', { isDirty: v });
  }

  _notifyHost(type, payload) {
    // Use the vscode postMessage bridge set from inline script
    try {
      if (typeof window.__vscodePostMessage === 'function') {
        window.__vscodePostMessage({ type, ...payload });
      }
    } catch {}
  }

  // ── Inverse / forward application ─────────────────────────────

  _applyInverse(change) {
    switch (change.kind) {
      case 'cell':
        this._applyInverseCell(change);
        break;
      case 'addRow':
        this._rows.splice(change.index, 1);
        break;
      case 'deleteRow':
        this._rows.splice(change.index, 0, change.rowData);
        break;
      case 'deleteRows': {
        const sorted = [...change.rowsData].sort((a, b) => a.index - b.index);
        for (let i = sorted.length - 1; i >= 0; i--) {
          this._rows.splice(sorted[i].index, 0, sorted[i].data);
        }
        break;
      }
      case 'sort': {
        const snapNames = this._snapshot.map(r => r.name);
        const rowMap = new Map(this._rows.map(r => [r.name, r]));
        this._rows.length = 0;
        for (const name of snapNames) {
          const existing = rowMap.get(name);
          if (existing) this._rows.push(existing);
        }
        const snapSet = new Set(snapNames);
        for (const r of rowMap.values()) {
          if (!snapSet.has(r.name)) this._rows.push(r);
        }
        break;
      }
      case 'renameColumn': {
        const row = this._rows[change.row];
        if (row) row.name = change.oldName;
        break;
      }
    }
  }

  _applyChange(change) {
    switch (change.kind) {
      case 'cell':
        this._applyForwardCell(change);
        break;
      case 'addRow':
        this._rows.splice(change.index, 0, change.rowData);
        break;
      case 'deleteRow':
        this._rows.splice(change.index, 1);
        break;
      case 'deleteRows': {
        const indices = change.rowsData.map(r => r.index).sort((a, b) => b - a);
        for (const idx of indices) {
          this._rows.splice(idx, 1);
        }
        break;
      }
      case 'sort': {
        const sortedNames = change.newOrder;
        const rowMap = new Map(this._rows.map(r => [r.name, r]));
        this._rows.length = 0;
        for (const name of sortedNames) {
          const existing = rowMap.get(name);
          if (existing) this._rows.push(existing);
        }
        const sortedSet = new Set(sortedNames);
        for (const r of rowMap.values()) {
          if (!sortedSet.has(r.name)) this._rows.push(r);
        }
        break;
      }
      case 'renameColumn': {
        const row = this._rows[change.row];
        if (row) row.name = change.newName;
        break;
      }
    }
  }

  _applyInverseCell(change) {
    const row = this._rows[change.row];
    if (!row) return;
    if (change.field === 'name') { row.name = change.oldValue; }
    else if (change.field === 'comment') { row.comment = change.oldValue; }
    else if (change.field === 'value') {
      const col = this._columns[change.col];
      if (col && col.kind === 'locale') row.values.set(col.locale, change.oldValue);
    }
  }

  _applyForwardCell(change) {
    const row = this._rows[change.row];
    if (!row) return;
    if (change.field === 'name') { row.name = change.newValue; }
    else if (change.field === 'comment') { row.comment = change.newValue; }
    else if (change.field === 'value') {
      const col = this._columns[change.col];
      if (col && col.kind === 'locale') row.values.set(col.locale, change.newValue);
    }
  }
}
