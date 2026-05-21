// Shared dependencies and constants for RESX editor webview modules.

const vscode = acquireVsCodeApi();

const table = document.querySelector('#csv-root table');
const scrollContainer = document.querySelector('.table-container');

const root = document.getElementById('csv-root');
const isResxMode = (root?.dataset?.resx === '1');
const hasHeader = document.querySelector('thead') !== null;

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

// Utilities
const parsePositiveNumber = value => {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Config constants
const configuredFontSizePx = parsePositiveNumber(root?.dataset?.fontsize);
const computedFontSizePx = parsePositiveNumber(window.getComputedStyle(document.body).fontSize);
const BASE_FONT_SIZE_PX = configuredFontSizePx ?? computedFontSizePx ?? 14;
const MOUSE_WHEEL_ZOOM_ENABLED = root?.dataset?.wheelzoomenabled !== '0';
const MOUSE_WHEEL_ZOOM_INVERTED = root?.dataset?.wheelzoominvert === '1';
const SINGLE_CLICK_EDIT = root?.dataset?.singleclickedit === '1';

const RESIZE_HANDLE_PX = 10;
const MIN_COL_WIDTH = 80;
const MIN_INDEX_COL_WIDTH = 30;
const DRAG_THRESHOLD_PX = 4;

// Cell helpers
const getCellCoords = cell => ({
  row: parseInt(cell.getAttribute('data-row')),
  col: parseInt(cell.getAttribute('data-col'))
});
const getCellTarget = target => {
  const el = (target instanceof Element) ? target : (target instanceof Node ? target.parentElement : null);
  return el ? el.closest('td, th') : null;
};
const isColumnHeaderCell = cell => cell && cell.tagName === 'TH' && cell.getAttribute('data-col') !== '-1' && cell.getAttribute('data-col') !== null;
const isRowIndexCell = cell => cell && cell.classList && cell.classList.contains('index-col');
const isActionCell = cell => cell && cell.classList && cell.classList.contains('action-col');

export {
  vscode,
  table,
  scrollContainer,
  root,
  isResxMode,
  hasHeader,
  resxColumns,
  resxDefaultValues,
  resxHasDefaultLocale,
  parsePositiveNumber,
  clamp,
  BASE_FONT_SIZE_PX,
  MOUSE_WHEEL_ZOOM_ENABLED,
  MOUSE_WHEEL_ZOOM_INVERTED,
  SINGLE_CLICK_EDIT,
  RESIZE_HANDLE_PX,
  MIN_COL_WIDTH,
  MIN_INDEX_COL_WIDTH,
  DRAG_THRESHOLD_PX,
  getCellCoords,
  getCellTarget,
  isColumnHeaderCell,
  isRowIndexCell,
  isActionCell,
};
