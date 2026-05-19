import { getFonts } from 'font-list';
import * as vscode from 'vscode';
import { ResxEditorProvider } from './ResxEditorProvider';

// ── Helpers ─────────────────────────────────────────────────────────

async function toggleBooleanConfig(key: string, defaultVal: boolean, messagePrefix: string) {
  const config = vscode.workspace.getConfiguration('resx');
  const currentVal = config.get<boolean>(key, defaultVal);
  const newVal = !currentVal;
  await config.update(key, newVal, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`${messagePrefix} ${newVal ? 'enabled' : 'disabled'}.`);
  ResxEditorProvider.editors.forEach(ed => ed.refresh());
}

// ── Command Registration ─────────────────────────────────────────────

export function registerResxCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    // Toggle extension on/off
    vscode.commands.registerCommand('resx.toggleExtension', () =>
      toggleBooleanConfig('enabled', true, 'RESX extension')
    ),

    // Change font family
    vscode.commands.registerCommand('resx.changeFontFamily', async () => {
      const resxCfg = vscode.workspace.getConfiguration('resx');
      const editorCfg = vscode.workspace.getConfiguration('editor');
      const currentResxFont = resxCfg.get<string>('fontFamily', '');
      const inheritedFont = editorCfg.get<string>('fontFamily', 'Menlo');
      const currentEffective = currentResxFont || inheritedFont;

      let fonts: string[] = [];
      try {
        fonts = (await getFonts()).map((f: string) => f.replace(/^"(.*)"$/, '$1')).sort();
      } catch (e) {
        console.error('RESX: unable to enumerate system fonts', e);
      }

      const picks = ['(inherit editor setting)', ...fonts];
      const choice = await vscode.window.showQuickPick(picks, {
        placeHolder: `Current: ${currentEffective}`
      });
      if (choice === undefined) { return; }

      const newVal = choice === '(inherit editor setting)' ? '' : choice;
      await resxCfg.update('fontFamily', newVal, vscode.ConfigurationTarget.Global);

      vscode.window.showInformationMessage(
        newVal ? `RESX font set to "${newVal}".` : 'RESX font now inherits editor.fontFamily.'
      );
      ResxEditorProvider.editors.forEach(ed => ed.refresh());
    }),

    // Add a new locale
    vscode.commands.registerCommand('resx.addLocale', async () => {
      const active = ResxEditorProvider.getActiveProvider();
      if (!active) {
        vscode.window.showInformationMessage('Open a .resx file in the RESX editor.');
        return;
      }

      const input = await vscode.window.showInputBox({
        prompt: 'Enter locale code (e.g. ja, en-US, fr, zh-Hans)',
        placeHolder: 'ja',
        validateInput: (val: string) => {
          const trimmed = val.trim();
          if (!trimmed) return 'Locale code is required.';
          if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]+)*$/.test(trimmed)) {
            return 'Invalid locale format. Use BCP-47 style (e.g. ja, en-US, zh-Hans).';
          }
          return undefined;
        }
      });
      if (input === undefined) { return; }

      const locale = input.trim();
      const uri = active.getDocumentUri();
      ResxEditorProvider.editors
        .filter(ed => ed.getDocumentUri().toString() === uri.toString())
        .forEach(ed => {
          try {
            const panel = (ed as any).currentWebviewPanel;
            if (panel) {
              panel.webview.postMessage({ type: 'addLocale', locale, row: -1, col: -1, value: '' });
            }
          } catch (err) {
            console.error('RESX: addLocale failed', err);
          }
        });

      vscode.window.showInformationMessage(`RESX: Adding locale "${locale}".`);
    }),

    // Refresh locale files (re-scan folder)
    vscode.commands.registerCommand('resx.refreshLocales', async () => {
      ResxEditorProvider.editors.forEach(ed => ed.refresh());
      vscode.window.showInformationMessage('RESX: Refreshed locale files.');
    }),

    // Sort entries alphabetically
    vscode.commands.registerCommand('resx.sortByName', async () => {
      const active = ResxEditorProvider.getActiveProvider();
      if (!active) {
        vscode.window.showInformationMessage('Open a .resx file in the RESX editor.');
        return;
      }
      const panel = (active as any).currentWebviewPanel;
      if (panel) {
        panel.webview.postMessage({
          type: 'sortRows',
          ascending: true,
          row: -1, col: -1, value: ''
        });
      }
      vscode.window.showInformationMessage('RESX: Sorted entries by name (A-Z).');
    })
  );
}
