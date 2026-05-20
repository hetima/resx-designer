import * as vscode from "vscode";
import * as path from "path";
import { ResxDocument, ResxLocaleSet } from "./types/resx";
import { findRelatedResxFiles, getSortedLocales } from "./resx-locale-finder";
import { serializeResx } from "./resx-writer";

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
    vscode.window.showErrorMessage(
      `RESX: Could not find related locale files for "${uri.fsPath}".`,
    );
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "resx.bulkEdit",
    `Edit ${name}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  console.log(
    "[bulkEdit] localeSet locales:",
    Array.from(localeSet.locales.keys()),
  );
  console.log("[bulkEdit] name:", name);
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
  /** 未保存の編集内容: locale → value */
  private pendingEdits = new Map<string | null, string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    localeSet: ResxLocaleSet,
    name: string,
  ) {
    this.panel = panel;
    this.localeSet = localeSet;
    this.name = name;

    panel.webview.html = this.buildHtml(panel.webview);
    panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables,
    );
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }

  // ── Webview HTML ────────────────────────────────────────────────

  private getLocaleValues(): LocaleValue[] {
    const sortedLocales = getSortedLocales(this.localeSet, null);
    return sortedLocales.map((loc) => {
      const doc = this.localeSet.locales.get(loc)!;
      const entry = doc.entries.find((e) => e.name === this.name);
      return {
        locale: loc,
        label: loc ?? "(default)",
        value: entry?.value ?? "",
        filePath: doc.path,
      };
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const config = vscode.workspace.getConfiguration("resx");
    const fontFamily = config.get<string>("fontFamily", "");
    const fontSize = config.get<number>("fontSize", 0);
    const cellPadding = config.get<number>("cellPadding", 4);
    const isDark =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;

    const bg = isDark ? "#1e1e1e" : "#ffffff";
    const fg = isDark ? "#cccccc" : "#333333";
    const border = isDark ? "#555555" : "#cccccc";
    const headerBg = isDark ? "#252526" : "#f0f0f0";
    const accent = "#007acc";
    const focusOutline = isDark ? "#007fd4" : "#007acc";

    const rootBg = isDark ? "#1e1e1e" : "#ffffff";
    const fontStr = fontFamily
      ? `${fontFamily}, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif`
      : "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
    const fontSizeStr = fontSize > 0 ? `${fontSize}px` : "inherit";

    const localeValues = this.getLocaleValues();
    const localeData = JSON.stringify(
      localeValues.map((v) => ({ locale: v.locale, value: v.value })),
    );

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
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
      background: ${isDark ? "rgba(255,100,100,0.1)" : "rgba(255,0,0,0.05)"};
    }
    td.value-col.empty {
      opacity: 0.5;
    }
    td.value-col.editing {
      outline: 2px solid ${accent};
      outline-offset: -2px;
    }
    #save-bar {
      position: sticky;
      bottom: 0;
      display: flex;
      justify-content: flex-end;
      padding: 8px 0 0 0;
      background: ${rootBg};
    }
    #saveBtn {
      padding: 4px 16px;
      background: ${accent};
      color: #fff;
      border: none;
      border-radius: 3px;
      font-size: inherit;
      cursor: pointer;
    }
    #saveBtn:disabled { opacity: 0.4; cursor: default; }
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
  <div id="save-bar">
    <button id="saveBtn" disabled>Save</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const localeData = ${localeData};
    console.log('[bulkEdit] localeData =', JSON.stringify(localeData));
    const tbody = document.getElementById('rows');
    console.log('[bulkEdit] tbody =', tbody);

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

    // Track edits
    let originalValues = localeData.map(v => v.value);
    let isDirty = false;
    const saveBtn = document.getElementById('saveBtn');

    function setDirty(val) {
      isDirty = val;
      saveBtn.disabled = !val;
    }

    // input イベントで即座に pendingEdits を通知（focusout 不要）
    tbody.addEventListener('input', (e) => {
      const cell = e.target.closest('td.value-col');
      if (!cell) return;
      const idx = parseInt(cell.dataset.idx, 10);
      const locale = cell.dataset.locale || null;
      const value = cell.textContent || '';
      cell.classList.toggle('empty', value === '');
      cell.classList.toggle('missing', value === '');
      localeData[idx].value = value;
      vscode.postMessage({ type: 'cellChanged', locale, value });
      setDirty(true);
    });

    tbody.addEventListener('focusout', (e) => {
      const cell = e.target.closest('td.value-col');
      if (!cell) return;
      const idx = parseInt(cell.dataset.idx, 10);
      const value = cell.textContent || '';
      cell.title = (value.indexOf('\\n') >= 0 || value.indexOf('\\r') >= 0) ? value : '';
    });

    // Keyboard: Enter moves to next; Tab moves to next/prev; Escape reverts
    tbody.addEventListener('keydown', (e) => {
      const cell = e.target.closest('td.value-col');
      if (!cell) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const nextCell = cell.closest('tr').nextElementSibling?.querySelector('td.value-col');
        if (nextCell) nextCell.focus();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const target = e.shiftKey
          ? cell.closest('tr').previousElementSibling?.querySelector('td.value-col')
          : cell.closest('tr').nextElementSibling?.querySelector('td.value-col');
        if (target) target.focus();
        return;
      }
      if (e.key === 'Escape') {
        const idx = parseInt(cell.dataset.idx, 10);
        cell.textContent = originalValues[idx];
        localeData[idx].value = originalValues[idx];
        cell.blur();
        return;
      }
    });

    // Save button
    saveBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'saveAll' });
      setDirty(false);
    });

    // Ctrl+S / Cmd+S
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (isDirty) {
          vscode.postMessage({ type: 'saveAll' });
          setDirty(false);
        }
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
          setDirty(true);
        }
      }
    } catch {}

    // 未保存で閉じようとしたとき確認 & 状態保存
    window.addEventListener('beforeunload', (e) => {
      vscode.setState({ localeData, isDirty });
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Scroll position persistence
    try {
      const st = vscode.getState();
      if (st && typeof st.scrollTop === 'number') {
        document.body.scrollTop = st.scrollTop;
        document.documentElement.scrollTop = st.scrollTop;
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
    if (msg.type === "cellChanged") {
      // 編集内容をメモリに保持するだけ（ファイルには書かない）
      this.pendingEdits.set(msg.locale ?? null, msg.value);
      if (!this.isDirty) {
        this.isDirty = true;
        this.panel.title = `Edit ${this.name} ●`;
      }
    } else if (msg.type === "saveAll") {
      await this.saveAll();
    }
  }

  private async saveAll(): Promise<void> {
    for (const [locale, value] of this.pendingEdits) {
      const doc = this.localeSet.locales.get(locale);
      if (!doc) {
        continue;
      }
      const entry = doc.entries.find((e) => e.name === this.name);
      if (entry) {
        entry.value = value;
      } else {
        doc.entries.push({ name: this.name, value, comment: "" });
      }
      const xml = serializeResx(doc);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(doc.path),
        new TextEncoder().encode(xml),
      );
    }
    this.pendingEdits.clear();
    this.isDirty = false;
    this.panel.title = `Edit ${this.name}`;
    vscode.window.showInformationMessage(`RESX: Saved "${this.name}"`);
  }

  // ── Utilities ──────────────────────────────────────────────────

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
