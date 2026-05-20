import * as vscode from 'vscode';
import * as path from 'path';
import { ResxDocument, ResxLocaleSet } from './types/resx';
import { findRelatedResxFiles, getSortedLocales } from './resx-locale-finder';
import { serializeResx } from './resx-writer';

// ── Public API ──────────────────────────────────────────────────────

/**
 * Open a standalone bulk-edit panel for a specific resource key.
 * The panel is fully independent of ResxEditorController — it reads/writes
 * .resx files directly using the existing parser/writer/locale-finder.
 *
 * @param context  Extension context (for extensionPath, etc.)
 * @param uri      URI of any .resx file in the locale set (used to discover related files)
 * @param name     The resource key to bulk-edit across all locales
 */
export async function openBulkEditPanel(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
  name: string,
): Promise<void> {
  // Discover all related locale files
  const localeSet = await findRelatedResxFiles(uri);
  if (!localeSet) {
    vscode.window.showErrorMessage(`RESX: Could not find related locale files for "${uri.fsPath}".`);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'resx.bulkEdit',
    `Edit ${name}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  const controller = new BulkEditController(context, panel, localeSet, name);
  context.subscriptions.push(controller);
}

// ── Internal ────────────────────────────────────────────────────────

interface LocaleValue {
  locale: string | null;
  label: string;
  value: string;
  filePath: string;
}

class BulkEditController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly panel: vscode.WebviewPanel;
  private readonly localeSet: ResxLocaleSet;
  private readonly name: string;
  private isDirty = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    localeSet: ResxLocaleSet,
    name: string,
  ) {
    this.panel = panel;
    this.localeSet = localeSet;
    this.name = name;

    panel.webview.html = this.buildHtml();
    panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.disposables.length = 0;
  }

  // ── Webview HTML ────────────────────────────────────────────────

  private getLocaleValues(): LocaleValue[] {
    const sortedLocales = getSortedLocales(this.localeSet, null);
    return sortedLocales.map(loc => {
      const doc = this.localeSet.locales.get(loc)!;
      const entry = doc.entries.find(e => e.name === this.name);
      return {
        locale: loc,
        label: loc ?? '(default)',
        value: entry?.value ?? '',
        filePath: doc.path,
      };
    });
  }

  private buildHtml(): string {
    const config = vscode.workspace.getConfiguration('resx');
    const fontFamily = config.get<string>('fontFamily', '');
    const fontSize = config.get<number>('fontSize', 0);
    const cellPadding = config.get<number>('cellPadding', 4);
    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;

    const bg = isDark ? '#1e1e1e' : '#ffffff';
    const fg = isDark ? '#cccccc' : '#333333';
    const border = isDark ? '#555555' : '#cccccc';
    const headerBg = isDark ? '#252526' : '#f0f0f0';
    const accent = '#007acc';
    const focusOutline = isDark ? '#007fd4' : '#007acc';

    const rootBg = isDark ? '#1e1e1e' : '#ffffff';
    const fontStr = fontFamily
      ? `${fontFamily}, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif`
      : "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
    const fontSizeStr = fontSize > 0 ? `${fontSize}px` : 'inherit';

    const localeValues = this.getLocaleValues();
    const localeData = JSON.stringify(localeValues.map(v => ({ locale: v.locale, value: v.value })));

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ${fontStr};
      font-size: ${fontSizeStr};
      background: ${rootBg};
      color: ${fg};
      padding: 16px;
    }
    h2 {
      font-size: 1.2em;
      font-weight: 600;
      margin-bottom: 12px;
      color: ${fg};
    }
    h2 .name {
      color: ${accent};
      font-family: Consolas, 'Courier New', monospace;
    }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    th, td {
      padding: ${cellPadding}px 12px;
      border: 1px solid ${border};
      font-size: inherit;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: ${headerBg};
      text-align: left;
      font-weight: 600;
      user-select: none;
      z-index: 1;
    }
    th.locale-col { width: 120px; }
    td.locale-col {
      background: ${headerBg};
      font-weight: 500;
      user-select: none;
    }
    td.value-col {
      outline: none;
      min-height: 1.4em;
      cursor: text;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      overflow: auto;
      max-height: 200px;
    }
    td.value-col:focus {
      outline: 2px solid ${focusOutline};
      outline-offset: -2px;
    }
    td.value-col.missing {
      background: ${isDark ? 'rgba(255,100,100,0.1)' : 'rgba(255,0,0,0.05)'};
    }
    td.value-col.empty {
      opacity: 0.5;
    }
    td.value-col.editing {
      outline: 2px solid ${accent};
      outline-offset: -2px;
    }
  </style>
</head>
<body>
  <h2>Editing <span class="name">${this.escapeHtml(this.name)}</span></h2>
  <table>
    <thead>
      <tr>
        <th class="locale-col">Locale</th>
        <th>Value</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const localeData = ${localeData};
    const tbody = document.getElementById('rows');

    function escapeHtml(text) {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function buildTitle(value) {
      return escapeHtml(value).replace(/\\n/g, '&#10;');
    }

    // Render initial rows
    localeData.forEach((item, idx) => {
      const tr = document.createElement('tr');
      const isMissing = item.value === '';
      const tdLocale = document.createElement('td');
      tdLocale.className = 'locale-col';
      tdLocale.textContent = item.locale === null ? '(default)' : item.locale;
      tr.appendChild(tdLocale);

      const tdValue = document.createElement('td');
      tdValue.className = 'value-col' + (item.value === '' ? ' empty missing' : '');
      tdValue.dataset.idx = idx;
      tdValue.dataset.locale = item.locale === null ? '' : item.locale;
      tdValue.contentEditable = 'true';
      tdValue.textContent = item.value;
      tdValue.title = item.value.indexOf('\\n') >= 0 || item.value.indexOf('\\r') >= 0 ? item.value : '';
      tr.appendChild(tdValue);

      tbody.appendChild(tr);
    });

    // Track edits and notify host
    let originalValues = localeData.map(v => v.value);
    let isDirty = false;

    function updateDirty() {
      let dirty = false;
      const cells = tbody.querySelectorAll('td.value-col');
      cells.forEach((cell, idx) => {
        if (cell.textContent !== originalValues[idx]) dirty = true;
      });
      if (dirty !== isDirty) {
        isDirty = dirty;
        vscode.postMessage({ type: 'dirtyChange', dirty });
      }
    }

    tbody.addEventListener('focusout', (e) => {
      const cell = e.target.closest('td.value-col');
      if (!cell) return;
      commitCell(cell);
    });

    function commitCell(cell) {
      const idx = parseInt(cell.dataset.idx, 10);
      const locale = cell.dataset.locale || null;
      const value = cell.textContent || '';
      cell.classList.toggle('empty', value === '');
      cell.classList.toggle('missing', value === '');
      cell.title = (value.indexOf('\\n') >= 0 || value.indexOf('\\r') >= 0) ? value : '';
      if (value !== originalValues[idx]) {
        originalValues[idx] = value;
        localeData[idx].value = value;
        vscode.postMessage({ type: 'editValue', locale, value });
        updateDirty();
      }
    }

    // Keyboard: Enter commits current cell, moves to next; Tab commits, moves to next sibling
    tbody.addEventListener('keydown', (e) => {
      const cell = e.target.closest('td.value-col');
      if (!cell) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitCell(cell);
        // Move focus to next row's value cell
        const nextCell = cell.closest('tr').nextElementSibling?.querySelector('td.value-col');
        if (nextCell) nextCell.focus();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        commitCell(cell);
        const target = e.shiftKey
          ? cell.closest('tr').previousElementSibling?.querySelector('td.value-col')
          : cell.closest('tr').nextElementSibling?.querySelector('td.value-col');
        if (target) target.focus();
        return;
      }
      // Escape: revert cell
      if (e.key === 'Escape') {
        const idx = parseInt(cell.dataset.idx, 10);
        cell.textContent = originalValues[idx];
        cell.blur();
        return;
      }
    });

    // Rehydrate state on reload
    try {
      const state = vscode.getState();
      if (state && Array.isArray(state.localeData)) {
        state.localeData.forEach((item, idx) => {
          const cell = tbody.querySelector('td[data-idx="' + idx + '"]');
          if (cell) {
            cell.textContent = item.value;
            cell.classList.toggle('empty', item.value === '');
            cell.classList.toggle('missing', item.value === '');
            originalValues[idx] = item.value;
            localeData[idx].value = item.value;
          }
        });
        if (state.isDirty) {
          isDirty = true;
          vscode.postMessage({ type: 'dirtyChange', dirty: true });
        }
      }
    } catch {}

    // Persist state on navigation/reload
    window.addEventListener('beforeunload', () => {
      vscode.setState({ localeData, isDirty });
    });

    // Scroll position persistence
    try {
      const st = vscode.getState();
      if (st && typeof st.scrollTop === 'number') {
        document.body.scrollTop = st.scrollTop || document.documentElement.scrollTop = st.scrollTop;
      }
    } catch {}
    window.addEventListener('scroll', () => {
      try { vscode.setState({ localeData, isDirty, scrollTop: document.body.scrollTop || document.documentElement.scrollTop }); } catch {}
    }, { passive: true });
  </script>
</body>
</html>`;
  }

  // ── Message Handling ────────────────────────────────────────────

  private async handleMessage(msg: any): Promise<void> {
    if (msg.type === 'editValue') {
      await this.handleEditValue(msg.locale ?? null, msg.value);
    } else if (msg.type === 'dirtyChange') {
      if (msg.dirty !== this.isDirty) {
        this.isDirty = msg.dirty;
        this.panel.title = this.isDirty ? `Edit ${this.name} ●` : `Edit ${this.name}`;
      }
    }
  }

  private async handleEditValue(locale: string | null, value: string): Promise<void> {
    const doc = this.localeSet.locales.get(locale);
    if (!doc) { return; }

    const entry = doc.entries.find(e => e.name === this.name);
    if (entry) {
      entry.value = value;
    } else {
      // Create a new entry if it doesn't exist yet in this locale file
      doc.entries.push({ name: this.name, value, comment: '' });
    }

    // Write the file
    const xml = serializeResx(doc);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(doc.path),
      new TextEncoder().encode(xml),
    );
  }

  // ── Utilities ──────────────────────────────────────────────────

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
