// Find & Replace widget.

import {
  vscode, table,
} from './shared.js';
import { selectCell } from './selection.js';

// ── State ─────────────────────────────────────────────────────────

let findRequestId = 0;
let findMatches = [];
let findMatchIndex = -1;
let findRegex = false;
let findWholeWord = false;
let findMatchCase = false;

// ── DOM refs ──────────────────────────────────────────────────────

const findWidget = document.getElementById('findReplaceWidget');
const findInput = document.getElementById('findInput');
const findStatus = document.getElementById('findStatus');
const findNextBtn = document.getElementById('findNext');
const findPrevBtn = document.getElementById('findPrev');
const findCloseBtn = document.getElementById('findClose');
const findCaseToggle = document.getElementById('findCaseToggle');
const findWordToggle = document.getElementById('findWordToggle');
const findRegexToggle = document.getElementById('findRegexToggle');

export { findWidget, findRequestId };

// ── Functions ─────────────────────────────────────────────────────

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
    return;
  }
  findStatus.textContent = `${findMatchIndex + 1} of ${total}`;
  findNextBtn.disabled = false;
  findPrevBtn.disabled = false;

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
  findWidget.classList.add('open');
  findInput.focus();
  findInput.select();
  if (findInput.value) doFind();
};

const closeFind = () => {
  if (!findWidget) return;
  findWidget.classList.remove('open');
  clearFindHighlights();
  findMatches = [];
  findMatchIndex = -1;
};

// ── Find result handler (called from message handler) ──────────────

const handleFindMatchesResult = (msg) => {
  if (msg.requestId === findRequestId) {
    findMatches = msg.matches || [];
    findMatchIndex = findMatches.length > 0 ? 0 : -1;
    updateFindUI();
  }
};

// ── Widget event listeners ───────────────────────────────────────

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

export {
  doFind,
  updateFindUI,
  navigateFindMatch,
  openFind,
  closeFind,
  handleFindMatchesResult,
};
