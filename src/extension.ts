import * as path from 'path';
import * as vscode from 'vscode';
import { ResxEditorProvider } from './ResxEditorProvider';
import { registerResxCommands } from './commands';

export function activate(context: vscode.ExtensionContext) {
  console.log('RESX: Extension activated');

  // Commands
  registerResxCommands(context);

  // Register the custom editor provider
  const provider = new ResxEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(ResxEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    })
  );

  // Auto-refresh all open RESX editors when relevant settings change
  const refreshKeys = [
    'resx.fontFamily',
    'resx.fontSize',
    'resx.cellPadding',
    'resx.mouseWheelZoom',
    'resx.mouseWheelZoomInvert',
  ];

  const cfgListener = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('resx.enabled')) {
      const enabled = vscode.workspace.getConfiguration('resx').get<boolean>('enabled', true);
      if (enabled) {
        // Reopen any open .resx files with our editor
        const groups = vscode.window.tabGroups.all;
        const candidates: Array<{
          group: vscode.TabGroup;
          tab: vscode.Tab;
          uri: vscode.Uri;
          wasActive: boolean;
          wasPreview: boolean;
          viewColumn: vscode.ViewColumn | undefined;
        }> = [];

        groups.forEach(group => {
          group.tabs.forEach(tab => {
            const input: any = (tab as any).input;
            const viewType = input?.viewType;
            const uri: vscode.Uri | undefined = input?.uri instanceof vscode.Uri ? input.uri : undefined;
            if (!input || !uri) return;
            if (viewType === ResxEditorProvider.viewType) return;
            if (!uri.fsPath.toLowerCase().endsWith('.resx')) return;
            candidates.push({
              group, tab, uri,
              wasActive: tab.isActive,
              wasPreview: tab.isPreview,
              viewColumn: group.viewColumn,
            });
          });
        });

        (async () => {
          const processed = new Set<string>();
          for (const c of candidates) {
            try { await vscode.window.tabGroups.close(c.tab); } catch {}
            try {
              await vscode.commands.executeCommand('vscode.openWith', c.uri, ResxEditorProvider.viewType, {
                viewColumn: c.viewColumn,
                preserveFocus: !c.wasActive,
                preview: c.wasPreview,
              });
              processed.add(c.uri.toString());
            } catch {}
          }
        })();
      } else {
        ResxEditorProvider.editors.forEach(ed => ed.refresh());
      }
    }

    const shouldRefresh = refreshKeys.some(key => e.affectsConfiguration(key));
    if (shouldRefresh) {
      ResxEditorProvider.editors.forEach(ed => {
        if (ed.isActive()) { ed.refresh(); }
      });
    }
  });

  context.subscriptions.push(cfgListener);

  // ── Auto-generate Designer.test.cs on .resx save ──────────────────
  const saveListener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    const config = vscode.workspace.getConfiguration('resx', doc.uri);
    const inspected = config.inspect<string>('defaultResx');
    // Only trigger when the user has explicitly set the value (workspace/folder/global)
    if (!inspected?.workspaceFolderValue && !inspected?.workspaceValue
      && !inspected?.globalValue && !inspected?.globalLanguageValue
      && !inspected?.workspaceLanguageValue && !inspected?.workspaceFolderLanguageValue) {
      return;
    }
    const defaultResx = config.get<string>('defaultResx')!;
    // Empty string means generation is disabled
    if (!defaultResx) { return; }

    // Only trigger for files matching the configured default resx
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const relativePath = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, doc.uri.fsPath).replace(/\\/g, '/')
      : path.basename(doc.uri.fsPath);
    if (relativePath !== defaultResx) { return; }

    const stem = path.basename(doc.uri.fsPath, '.resx');
    const outputPath = path.join(path.dirname(doc.uri.fsPath), `${stem}.Designer.test.cs`);

    const content = `// Generated at ${new Date().toISOString()}`;

    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(outputPath),
        Buffer.from(content, 'utf8')
      );
      vscode.window.showInformationMessage(`RESX: Generated ${path.basename(outputPath)}`);
    } catch (e) {
      vscode.window.showErrorMessage(`RESX: Failed to generate ${path.basename(outputPath)}: ${e}`);
    }
  });

  context.subscriptions.push(saveListener);
}

export function deactivate() {}
