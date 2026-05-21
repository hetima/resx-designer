// RESX Editor Webview — Entry point.
// Initializes theme, state persistence, toolbar, and host message handler.
// Side-effect imports handle: mouse, keyboard, dialogs, find.

import { vscode, table, isResxMode, scrollContainer, MOUSE_WHEEL_ZOOM_ENABLED, MOUSE_WHEEL_ZOOM_INVERTED } from './shared.js';
import { persistState, restoreState, zoomIn, zoomOut, isZoomModifier, handleClearState } from './state.js';
import { clearSelection, selectCell, commitEdit, updateMissingHighlight } from './selection.js';
import { handleFindMatchesResult, findRequestId } from './find.js';

// Side-effect imports (register listeners)
import './mouse.js';
import './commands.js';
import './dialogs.js';

// ── Initial setup ──────────────────────────────────────────────────

document.body.setAttribute('tabindex', '0');
if (!window.__resxThemeUpdate) {
  try { document.body.focus({ preventScroll: true }); } catch { try { document.body.focus(); } catch {} }
}

// ── Theme-only update handler (avoids full HTML rebuild) ─────────

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg?.type === 'updateTheme') {
    let styleEl = document.getElementById('resx-theme-vars');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'resx-theme-vars';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `:root { ${msg.cssVars} }`;
  }
});

// ── Toolbar buttons ────────────────────────────────────────────────

document.getElementById('addLangBtn')?.addEventListener('click', () => {
  try { window.__addLangDialog.open(); } catch {}
});

document.getElementById('addKeyBtn')?.addEventListener('click', () => {
  try { window.__addKeyDialog.open(); } catch {}
});

document.getElementById('sortAZBtn')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'sortCurrentFile', ascending: true });
});

document.getElementById('viewModeBtn')?.addEventListener('click', () => {
  const btn = document.getElementById('viewModeBtn');
  const isSingle = btn?.textContent?.includes('Multi');
  const mode = isSingle ? 'multi' : 'single';
  vscode.postMessage({ type: 'setViewMode', mode });
});

document.getElementById('openAsTextBtn')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'openAsText' });
});

// ── State persistence events ───────────────────────────────────────

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

// ── Host to Webview messages ───────────────────────────────────────

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
      handleFindMatchesResult(msg);
      break;
    case 'addLocale':
      break;
    case 'addLocaleResult':
      if (msg.success) {
        const langMsgEl = document.getElementById('addLangMessage');
        if (langMsgEl) {
          langMsgEl.textContent = msg.message;
          langMsgEl.classList.remove('add-lang-error');
          langMsgEl.classList.add('add-lang-success');
        }
        setTimeout(() => {
          try { window.__addLangDialog.close(); } catch {}
        }, 800);
      } else {
        const langMsgEl = document.getElementById('addLangMessage');
        if (langMsgEl) {
          langMsgEl.textContent = msg.message;
          langMsgEl.classList.remove('add-lang-success');
          langMsgEl.classList.add('add-lang-error');
        }
        const langOkBtn = document.getElementById('addLangOk');
        if (langOkBtn) langOkBtn.disabled = false;
      }
      break;
    case 'addKeyResult':
      if (msg.success) {
        const keyMsgEl = document.getElementById('addKeyMessage');
        if (keyMsgEl) {
          keyMsgEl.textContent = msg.message;
          keyMsgEl.classList.remove('add-lang-error');
          keyMsgEl.classList.add('add-lang-success');
        }
        const rowIdx = msg.rowIndex;
        setTimeout(() => {
          try { window.__addKeyDialog.close(); } catch {}
          setTimeout(() => {
            const targetRow = document.querySelector(`td[data-row="${rowIdx}"]`);
            if (targetRow) {
              targetRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }, 100);
        }, 800);
      } else {
        const keyMsgEl = document.getElementById('addKeyMessage');
        if (keyMsgEl) {
          keyMsgEl.textContent = msg.message;
          keyMsgEl.classList.remove('add-lang-success');
          keyMsgEl.classList.add('add-lang-error');
        }
        const keyOkBtn = document.getElementById('addKeyOk');
        if (keyOkBtn) keyOkBtn.disabled = false;
      }
      break;
    case 'clearState':
      handleClearState();
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
