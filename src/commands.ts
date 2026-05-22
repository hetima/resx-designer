import * as path from 'path';
import { getFonts } from 'font-list';
import * as vscode from 'vscode';
import { ResxEditProvider } from './ResxEdit';
import { ResxEditorProvider } from './ResxEditorProvider';
import { parseResx } from './resx-parser';
import { serializeResx } from './resx-writer';
import { findRelatedResxFiles, parseResxFilename } from './resx-locale-finder';
import { normalizeDefaultResxList } from './resx-config';

// ── Helpers ─────────────────────────────────────────────────────────

const STATE_KEY_PREFIX = 'resx.';

/** Clear all persisted RESX state from workspaceState and globalState, then refresh editors. */
async function clearAllExtensionState(context: vscode.ExtensionContext): Promise<string[]> {
  const removed: string[] = [];

  for (const store of [context.workspaceState, context.globalState] as const) {
    for (const key of store.keys()) {
      if (!key.startsWith(STATE_KEY_PREFIX)) { continue; }
      try {
        await store.update(key, undefined);
        removed.push(`${store === context.workspaceState ? 'workspace' : 'global'}:${key}`);
      } catch (e) {
        console.warn(`RESX: failed to clear key "${key}"`, e);
      }
    }
  }

  // Refresh all open RESX editors so webview state is also reset
  ResxEditProvider.controllers.forEach(ed => ed.refresh());

  return removed;
}

async function toggleBooleanConfig(key: string, defaultVal: boolean, messagePrefix: string) {
  const config = vscode.workspace.getConfiguration('resx');
  const currentVal = config.get<boolean>(key, defaultVal);
  const newVal = !currentVal;
  await config.update(key, newVal, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`${messagePrefix} ${newVal ? 'enabled' : 'disabled'}.`);
  ResxEditProvider.controllers.forEach(ed => ed.refresh());
}

// ── Command Registration ─────────────────────────────────────────────

export function registerResxCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    // Toggle extension on/off
    vscode.commands.registerCommand("resx.toggleExtension", () =>
      toggleBooleanConfig("enabled", true, "RESX extension"),
    ),

    // Change font family
    vscode.commands.registerCommand("resx.changeFontFamily", async () => {
      const resxCfg = vscode.workspace.getConfiguration("resx");
      const editorCfg = vscode.workspace.getConfiguration("editor");
      const currentResxFont = resxCfg.get<string>("fontFamily", "");
      const inheritedFont = editorCfg.get<string>("fontFamily", "Menlo");
      const currentEffective = currentResxFont || inheritedFont;

      let fonts: string[] = [];
      try {
        fonts = (await getFonts())
          .map((f: string) => f.replace(/^"(.*)"$/, "$1"))
          .sort();
      } catch (e) {
        console.error("RESX: unable to enumerate system fonts", e);
      }

      const picks = ["(inherit editor setting)", ...fonts];
      const choice = await vscode.window.showQuickPick(picks, {
        placeHolder: `Current: ${currentEffective}`,
      });
      if (choice === undefined) {
        return;
      }

      const newVal = choice === "(inherit editor setting)" ? "" : choice;
      await resxCfg.update(
        "fontFamily",
        newVal,
        vscode.ConfigurationTarget.Global,
      );

      vscode.window.showInformationMessage(
        newVal
          ? `RESX font set to "${newVal}".`
          : "RESX font now inherits editor.fontFamily.",
      );
      ResxEditProvider.controllers.forEach((ed) => ed.refresh());
    }),

    // Add a new locale
    vscode.commands.registerCommand("resx.addLocale", async () => {
      const active = ResxEditProvider.getActiveController();
      if (!active) {
        vscode.window.showInformationMessage(
          "Open a .resx file in the RESX editor.",
        );
        return;
      }

      const input = await vscode.window.showInputBox({
        prompt: "Enter locale code (e.g. ja, en-US, fr, zh-Hans)",
        placeHolder: "ja",
        validateInput: (val: string) => {
          const trimmed = val.trim();
          if (!trimmed) return "Locale code is required.";
          if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]+)*$/.test(trimmed)) {
            return "Invalid locale format. Use BCP-47 style (e.g. ja, en-US, zh-Hans).";
          }
          return undefined;
        },
      });
      if (input === undefined) {
        return;
      }

      const locale = input.trim();
      const uri = active.getDocumentUri();
      ResxEditProvider.controllers
        .filter((ed) => ed.getDocumentUri().toString() === uri.toString())
        .forEach((ed) => {
          try {
            const panel = (ed as any)._panel;
            if (panel) {
              panel.webview.postMessage({
                type: "addLocale",
                locale,
                row: -1,
                col: -1,
                value: "",
              });
            }
          } catch (err) {
            console.error("RESX: addLocale failed", err);
          }
        });

      vscode.window.showInformationMessage(`RESX: Adding locale "${locale}".`);
    }),

    // Refresh locale files (re-scan folder)
    vscode.commands.registerCommand("resx.refreshLocales", async () => {
      ResxEditProvider.controllers.forEach((ed) => ed.refresh());
      vscode.window.showInformationMessage("RESX: Refreshed locale files.");
    }),

    // Sort entries alphabetically (all locale files, immediate save)
    vscode.commands.registerCommand("resx.sortByName", async () => {
      const active = ResxEditProvider.getActiveController();
      if (!active) {
        vscode.window.showInformationMessage(
          "Open a .resx file in the RESX editor.",
        );
        return;
      }
      active.handleSortRows(true, true);
      vscode.window.showInformationMessage(
        "RESX: Sorted entries by name (A-Z).",
      );
    }),

    // Sort default file names (standalone command, immediate save)
    vscode.commands.registerCommand("resx.sortDefaultFileKeys", async () => {
      const config = vscode.workspace.getConfiguration("resx");
      const defaultResxList = normalizeDefaultResxList(config.get<string | string[]>("defaultResx"));
      if (defaultResxList.length === 0) {
        vscode.window.showErrorMessage("RESX: resx.defaultResx is not configured.");
        return;
      }
      const folders = vscode.workspace.workspaceFolders;
      if (!folders) {
        vscode.window.showErrorMessage("RESX: No workspace folder open.");
        return;
      }
      // If multiple defaults, let the user pick one
      let picked: string;
      if (defaultResxList.length === 1) {
        picked = defaultResxList[0];
      } else {
        const choice = await vscode.window.showQuickPick(defaultResxList, {
          placeHolder: "Select which default .resx to sort",
        });
        if (!choice) { return; }
        picked = choice;
      }
      const filePath = path.join(folders[0].uri.fsPath, picked);
      const uri = vscode.Uri.file(filePath);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        vscode.window.showErrorMessage(`RESX: File not found: ${picked}`);
        return;
      }
      const content = await vscode.workspace.fs.readFile(uri);
      const xmlText = new TextDecoder('utf-8').decode(content);
      const doc = parseResx(xmlText, filePath);
      doc.entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      const xml = serializeResx(doc);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(xml));
      vscode.window.showInformationMessage(`RESX: Sorted ${picked} by name.`);
    }),

    // Sort all locale file names (standalone command, immediate save)
    vscode.commands.registerCommand("resx.sortAllFileKeys", async () => {
      const config = vscode.workspace.getConfiguration("resx");
      const defaultResxList = normalizeDefaultResxList(config.get<string | string[]>("defaultResx"));
      if (defaultResxList.length === 0) {
        vscode.window.showErrorMessage("RESX: resx.defaultResx is not configured.");
        return;
      }
      const folders = vscode.workspace.workspaceFolders;
      if (!folders) {
        vscode.window.showErrorMessage("RESX: No workspace folder open.");
        return;
      }
      // If multiple defaults, let the user pick one
      let picked: string;
      if (defaultResxList.length === 1) {
        picked = defaultResxList[0];
      } else {
        const choice = await vscode.window.showQuickPick(defaultResxList, {
          placeHolder: "Select which default .resx to sort (and its locales)",
        });
        if (!choice) { return; }
        picked = choice;
      }
      const filePath = path.join(folders[0].uri.fsPath, picked);
      const uri = vscode.Uri.file(filePath);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        vscode.window.showErrorMessage(`RESX: File not found: ${picked}`);
        return;
      }
      const localeSet = await findRelatedResxFiles(uri);
      if (!localeSet) {
        vscode.window.showErrorMessage(`RESX: Could not load locale set from ${picked}`);
        return;
      }
      let count = 0;
      for (const [, doc] of localeSet.locales) {
        doc.entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        const xml = serializeResx(doc);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(doc.path), new TextEncoder().encode(xml));
        count++;
      }
      vscode.window.showInformationMessage(`RESX: Sorted ${count} file(s) by name.`);
    }),

    // Debug: clear all workspace & global state (column sizes, row sizes, view mode, etc.)
    vscode.commands.registerCommand("resx.debugClearState", async () => {
      const yes = await vscode.window.showWarningMessage(
        "This will clear all persisted RESX state (column/row sizes, view mode, serial index) for this workspace. Continue?",
        { modal: true },
        "Clear",
      );
      if (yes !== "Clear") {
        return;
      }

      // Send clearState to every open webview so that webview-level
      // persisted state (columnSizes, rowSizes, zoomScale, scroll) is also reset.
      for (const ed of ResxEditProvider.controllers) {
        try {
          const panel = (ed as any)._panel;
          panel?.webview.postMessage({ type: "clearState" });
        } catch {
          /* ignore */
        }
      }

      const removed = await clearAllExtensionState(context);

      // Delay refresh so webview can process clearState before reload
      setTimeout(() => {
        ResxEditProvider.controllers.forEach((ed) => ed.refresh());
      }, 100);

      vscode.window.showInformationMessage(
        `RESX: Cleared ${removed.length} state key(s): ${removed.join(", ")}`,
      );
    }),

    // Set a .resx file as the default resx for test generation.
    // - Context menu: clicked URI is provided → overwrite with that file's relative path.
    // - Command palette: no URI argument → prompt the user for a path.
    vscode.commands.registerCommand(
      "resx.setDefaultResx",
      async (clickedUri?: vscode.Uri) => {
        if (clickedUri) {
          // Called from context menu — overwrite with the clicked file's relative path
          const workspaceFolder =
            vscode.workspace.getWorkspaceFolder(clickedUri);
          const relativePath = workspaceFolder
            ? path
                .relative(workspaceFolder.uri.fsPath, clickedUri.fsPath)
                .replace(/\\/g, "/")
            : path.basename(clickedUri.fsPath);

          await vscode.workspace
            .getConfiguration("resx", clickedUri)
            .update(
              "defaultResx",
              relativePath,
              vscode.ConfigurationTarget.WorkspaceFolder,
            );
          vscode.window.showInformationMessage(
            `RESX: Default resx set to "${relativePath}".`,
          );
        } else {
          // Called from command palette — let the user type a path (empty string disables)
          const cfg = vscode.workspace.getConfiguration("resx");
          const existing = normalizeDefaultResxList(
            cfg.get<string | string[]>("defaultResx"),
          );
          const currentDisplay = existing.join(", ");
          const input = await vscode.window.showInputBox({
            prompt:
              "Enter the relative path of the default .resx file (empty to disable).",
            value: currentDisplay,
            placeHolder: "e.g. Resources/Strings.resx",
          });
          if (input === undefined) {
            return;
          } // cancelled

          const targetUri = vscode.window.activeTextEditor?.document.uri;
          const cfgUpdate = vscode.workspace.getConfiguration("resx", targetUri);
          if (!input) {
            await cfgUpdate.update(
              "defaultResx",
              undefined,
              vscode.ConfigurationTarget.WorkspaceFolder,
            );
            vscode.window.showInformationMessage(
              "RESX: Default resx cleared. Generation disabled.",
            );
          } else {
            await cfgUpdate.update(
              "defaultResx",
              input,
              vscode.ConfigurationTarget.WorkspaceFolder,
            );
            vscode.window.showInformationMessage(
              `RESX: Default resx set to "${input}".`,
            );
          }
        }
      },
    ),

  );
}
