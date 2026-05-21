// Dialogs — Add Language, Add Key, Insert Key, Delete Key, Action Menu integration.

import { vscode } from './shared.js';
import { closeActionMenu } from './mouse.js';

// ── Add Language dialog ─────────────────────────────────────────

(function initAddLangDialog() {
  let dialogEl = null;

  const KNOWN_LOCALES = new Set([
    'af','am','ar','as','az','be','bg','bn','bs','ca','cs','cy','da','de','dv','el',
    'en','en-AU','en-CA','en-GB','en-IN','en-US','en-ZA','eo','es','es-ES','es-MX',
    'et','eu','fa','fi','fo','fr','fr-CA','fr-FR','ga','gd','gl','gu','he','hi','hr',
    'hu','hy','id','ig','is','it','ja','ka','kk','km','kn','ko','ku','ky','lb','lo',
    'lt','lv','mk','ml','mn','mr','ms','mt','nb','ne','nl','nn','no','or','pa','pl',
    'ps','pt','pt-BR','pt-PT','qu','ro','ru','rw','sd','si','sk','sl','so','sq','sr',
    'sv','sw','ta','te','th','ti','tk','tl','tn','tr','tt','ug','uk','ur','uz','vi',
    'wo','xh','yi','yo','zh','zh-CN','zh-Hans','zh-Hant','zh-HK','zh-TW','zu','ff',
    'ha','ibb','ig','ku','nds','nl-BE','nn','pa','pap','sat','sd','sr-Cyrl','sr-Latn',
    'szl','tg','tk','tok','tzm','uz','vec',
  ]);

  function isValidLocaleFormat(v) {
    return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]+)*$/.test(v);
  }

  function openDialog() {
    if (dialogEl) { dialogEl.remove(); }

    dialogEl = document.createElement('div');
    dialogEl.className = 'add-lang-overlay';
    dialogEl.innerHTML = `
      <div class="add-lang-dialog">
        <div class="add-lang-title">Add Language</div>
        <div class="add-lang-field">
          <input id="addLangInput" class="add-lang-input" type="text"
                 placeholder="Locale code (e.g. ja, en-US, fr)" spellcheck="false"
                 list="addLangSuggestions" autocomplete="off">
          <datalist id="addLangSuggestions"></datalist>
        </div>
        <div id="addLangWarning" class="add-lang-warning"></div>
        <label class="add-lang-checkbox-label">
          <input id="addLangFillDefaults" type="checkbox" checked>
          Copy default values
        </label>
        <div id="addLangMessage" class="add-lang-message"></div>
        <div class="add-lang-buttons">
          <button id="addLangCancel" class="add-lang-btn">Cancel</button>
          <button id="addLangOk" class="add-lang-btn">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialogEl);

    // Populate datalist
    const datalist = document.getElementById('addLangSuggestions');
    KNOWN_LOCALES.forEach(loc => {
      const opt = document.createElement('option');
      opt.value = loc;
      datalist.appendChild(opt);
    });

    const input = document.getElementById('addLangInput');
    const warnEl = document.getElementById('addLangWarning');
    const msgEl = document.getElementById('addLangMessage');
    const okBtn = document.getElementById('addLangOk');
    const cancelBtn = document.getElementById('addLangCancel');

    msgEl.textContent = '';
    input.focus();

    function updateWarning() {
      const v = input.value.trim();
      if (!v || !isValidLocaleFormat(v)) { warnEl.textContent = ''; return; }
      warnEl.textContent = KNOWN_LOCALES.has(v) ? '' : '⚠ Unknown locale code';
    }
    input.addEventListener('input', updateWarning);

    function closeDialog() {
      if (dialogEl) { dialogEl.remove(); dialogEl = null; }
    }

    cancelBtn.addEventListener('click', closeDialog);
    dialogEl.addEventListener('click', (e) => {
      if (e.target === dialogEl) closeDialog();
    });

    okBtn.addEventListener('click', () => {
      const locale = input.value.trim();
      if (!locale) {
        msgEl.textContent = 'Locale code is required.';
        msgEl.classList.add('add-lang-error');
        return;
      }
      if (!isValidLocaleFormat(locale)) {
        msgEl.textContent = 'Invalid format. Use BCP-47 style (e.g. ja, en-US, zh-Hans).';
        msgEl.classList.add('add-lang-error');
        return;
      }
      const fillDefaults = document.getElementById('addLangFillDefaults').checked;
      vscode.postMessage({ type: 'addLocale', locale, fillDefaults });
      okBtn.disabled = true;
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') okBtn.click();
      if (e.key === 'Escape') closeDialog();
    });
  }

  window.__addLangDialog = { open: openDialog, close: () => { if (dialogEl) { dialogEl.remove(); dialogEl = null; } } };
})();

// ── Add Key dialog ─────────────────────────────────────────────

(function initAddKeyDialog() {
  let dialogEl = null;

  function openDialog() {
    if (dialogEl) { dialogEl.remove(); }

    dialogEl = document.createElement('div');
    dialogEl.className = 'add-lang-overlay';
    dialogEl.innerHTML = `
      <div class="add-lang-dialog">
        <div class="add-lang-title">Add Key</div>
        <div class="add-lang-field">
          <input id="addKeyInput" class="add-lang-input" type="text"
                 placeholder="Resource key name" spellcheck="false" autocomplete="off">
        </div>
        <label class="add-lang-checkbox-label">
          <input id="addKeyAddToAll" type="checkbox" checked>
          Add to all languages
        </label>
        <div id="addKeyMessage" class="add-lang-message"></div>
        <div class="add-lang-buttons">
          <button id="addKeyCancel" class="add-lang-btn">Cancel</button>
          <button id="addKeyOk" class="add-lang-btn">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialogEl);

    const input = document.getElementById('addKeyInput');
    const msgEl = document.getElementById('addKeyMessage');
    const okBtn = document.getElementById('addKeyOk');
    const cancelBtn = document.getElementById('addKeyCancel');

    msgEl.textContent = '';
    input.focus();

    function closeDialog() {
      if (dialogEl) { dialogEl.remove(); dialogEl = null; }
    }

    cancelBtn.addEventListener('click', closeDialog);
    dialogEl.addEventListener('click', (e) => {
      if (e.target === dialogEl) closeDialog();
    });

    okBtn.addEventListener('click', () => {
      const name = input.value.trim();
      if (!name) {
        msgEl.textContent = 'Key name is required.';
        msgEl.classList.add('add-lang-error');
        return;
      }
      const addToAll = document.getElementById('addKeyAddToAll').checked;
      vscode.postMessage({ type: 'addKey', name, addToAll });
      okBtn.disabled = true;
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') okBtn.click();
      if (e.key === 'Escape') closeDialog();
    });
  }

  window.__addKeyDialog = { open: openDialog, close: () => { if (dialogEl) { dialogEl.remove(); dialogEl = null; } } };
})();

// ── Insert key below dialog ─────────────────────────────────────

export const openInsertKeyDialog = (afterName, afterRow) => {
  closeActionMenu();
  let dialogEl = null;

  dialogEl = document.createElement('div');
  dialogEl.className = 'add-lang-overlay';
  dialogEl.innerHTML = `
    <div class="add-lang-dialog">
      <div class="add-lang-title">Insert New Key Below</div>
      <div class="add-lang-field">
        <input id="insertKeyInput" class="add-lang-input" type="text"
               placeholder="Resource key name" spellcheck="false" autocomplete="off">
      </div>
      <label class="add-lang-checkbox-label">
        <input id="insertKeyAddToAll" type="checkbox" checked>
        Add to all languages
      </label>
      <div id="insertKeyMessage" class="add-lang-message"></div>
      <div class="add-lang-buttons">
        <button id="insertKeyCancel" class="add-lang-btn">Cancel</button>
        <button id="insertKeyOk" class="add-lang-btn">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialogEl);

  const input = document.getElementById('insertKeyInput');
  const msgEl = document.getElementById('insertKeyMessage');
  const okBtn = document.getElementById('insertKeyOk');
  const cancelBtn = document.getElementById('insertKeyCancel');
  msgEl.textContent = '';
  input.focus();

  function closeDialog() {
    if (dialogEl) { dialogEl.remove(); dialogEl = null; }
  }

  cancelBtn.addEventListener('click', closeDialog);
  dialogEl.addEventListener('click', (e) => {
    if (e.target === dialogEl) closeDialog();
  });

  okBtn.addEventListener('click', () => {
    const name = input.value.trim();
    if (!name) {
      msgEl.textContent = 'Key name is required.';
      msgEl.classList.add('add-lang-error');
      return;
    }
    const addToAll = document.getElementById('insertKeyAddToAll').checked;
    vscode.postMessage({ type: 'addKey', name, addToAll, insertAfterIndex: afterRow });
    proceedAfterAddKeyResult(closeDialog, msgEl);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') okBtn.click();
    if (e.key === 'Escape') closeDialog();
  });
};

/** Close dialog and reset message on addKeyResult from host */
const proceedAfterAddKeyResult = (closeFn, msgEl) => {
  const handler = (e) => {
    if (e.data?.type === 'addKeyResult') {
      window.removeEventListener('message', handler);
      if (e.data.success) {
        closeFn();
      } else {
        msgEl.textContent = e.data.message || 'Error';
        msgEl.classList.add('add-lang-error');
      }
    }
  };
  window.addEventListener('message', handler);
};

// ── Delete key dialog ──────────────────────────────────────────

export const openDeleteKeyDialog = (name) => {
  closeActionMenu();
  let dialogEl = null;

  dialogEl = document.createElement('div');
  dialogEl.className = 'add-lang-overlay';
  dialogEl.innerHTML = `
    <div class="add-lang-dialog">
      <div class="add-lang-title">Delete Key</div>
      <div class="add-lang-message" style="color: var(--vscode-notificationsErrorIcon-foreground, #f44); font-weight: 500;">"${name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}" will be deleted. This cannot be undone.</div>
      <label class="add-lang-checkbox-label">
        <input id="deleteKeyAllFiles" type="checkbox" checked>
        Delete from all .resx files
      </label>
      <div id="deleteKeyMessage" class="add-lang-message"></div>
      <div class="add-lang-buttons">
        <button id="deleteKeyCancel" class="add-lang-btn">Cancel</button>
        <button id="deleteKeyOk" class="add-lang-btn" style="background: var(--vscode-notificationsErrorIcon-foreground, #f44); color: #fff;">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialogEl);

  const msgEl = document.getElementById('deleteKeyMessage');
  const okBtn = document.getElementById('deleteKeyOk');
  const cancelBtn = document.getElementById('deleteKeyCancel');

  function closeDialog() {
    if (dialogEl) { dialogEl.remove(); dialogEl = null; }
  }

  cancelBtn.addEventListener('click', closeDialog);
  dialogEl.addEventListener('click', (e) => {
    if (e.target === dialogEl) closeDialog();
  });

  okBtn.addEventListener('click', () => {
    const allFiles = document.getElementById('deleteKeyAllFiles').checked;
    vscode.postMessage({ type: 'deleteKey', name, allFiles });
    okBtn.disabled = true;
  });

  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { closeDialog(); document.removeEventListener('keydown', onKey); }
  });
};
