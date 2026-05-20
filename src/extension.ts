import * as path from 'path';
import * as vscode from 'vscode';
import { ResxEditorProvider } from './ResxEditorProvider';
import { registerResxCommands } from './commands';
import { parseResx } from './resx-parser';

export function activate(context: vscode.ExtensionContext) {
  console.log('RESX: Extension activated');

  const extensionVersion = context.extension.packageJSON.version as string;

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

  // ── Auto-generate Designer.cs on .resx save ──────────────────────
  const saveListener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    const config = vscode.workspace.getConfiguration('resx', doc.uri);
    const inspected = config.inspect<string>('defaultResx');
    if (!inspected?.workspaceFolderValue && !inspected?.workspaceValue
      && !inspected?.globalValue && !inspected?.globalLanguageValue
      && !inspected?.workspaceLanguageValue && !inspected?.workspaceFolderLanguageValue) {
      return;
    }
    const defaultResx = config.get<string>('defaultResx')!;
    if (!defaultResx) { return; }

    const wsFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const relativePath = wsFolder
      ? path.relative(wsFolder.uri.fsPath, doc.uri.fsPath).replace(/\\/g, '/')
      : path.basename(doc.uri.fsPath);
    if (relativePath !== defaultResx) { return; }

    await regenerateDesignerCs(doc, wsFolder, config, extensionVersion);
  });

  context.subscriptions.push(saveListener);
}

// ── Designer.cs Generation ─────────────────────────────────────────

async function regenerateDesignerCs(
  doc: vscode.TextDocument,
  wsFolder: vscode.WorkspaceFolder | undefined,
  config: vscode.WorkspaceConfiguration,
  extensionVersion: string,
): Promise<void> {
  try {
    const stem = path.basename(doc.uri.fsPath, '.resx');
    const resxDir = path.dirname(doc.uri.fsPath);
    const outputPath = path.join(resxDir, `${stem}.Designer.cs`);
    const outputUri = vscode.Uri.file(outputPath);

    // 1. Read resx names
    const resxDoc = parseResx(doc.getText(), doc.uri.fsPath);
    const resxNames = resxDoc.entries.map(e => e.name).sort();

    // 2. Read existing Designer.cs if present
    let existingNames: string[] = [];
    let existingRootNs = '';
    let existingSecondNs = '';
    try {
      const bytes = await vscode.workspace.fs.readFile(outputUri);
      const text = new TextDecoder('utf-8').decode(bytes);
      existingNames = [...text.matchAll(/internal\s+static\s+string\s+(\w+)/g)].map(m => m[1]).sort();
      const nsMatch = text.match(/^namespace\s+([\S]+)/m);
      if (nsMatch) { existingRootNs = nsMatch[1]; }
      const rmMatch = text.match(/new\s+global::System\.Resources\.ResourceManager\("([^"]+)"/);
      if (rmMatch) { existingSecondNs = rmMatch[1]; }
    } catch {
      // File does not exist yet — that's fine
    }

    // 3. Compare — skip if identical
    if (existingNames.length > 0 && arraysEqual(existingNames, resxNames)) {
      return; // No changes needed
    }

    // 4. Determine namespaces
    const rootNs = determineRootNamespace(existingRootNs, config, doc.uri, wsFolder, stem);
    const secondNs = determineSecondNamespace(existingSecondNs, config, doc.uri, wsFolder, stem);

    // 5. Generate content
    const content = generateDesignerCsContent(stem, rootNs, secondNs, resxNames, extensionVersion);

    // 6. Write
    await vscode.workspace.fs.writeFile(outputUri, new TextEncoder().encode(content));
    vscode.window.showInformationMessage(`RESX: Generated ${path.basename(outputPath)}`);
  } catch (e) {
    vscode.window.showErrorMessage(`RESX: Failed to generate Designer.cs: ${e}`);
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) { return false; }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { return false; }
  }
  return true;
}

function determineRootNamespace(
  existing: string,
  config: vscode.WorkspaceConfiguration,
  docUri: vscode.Uri,
  wsFolder: vscode.WorkspaceFolder | undefined,
  stem: string,
): string {
  if (existing) { return existing; }
  const cfgNs = config.get<string>('defaultNamespace', '');
  if (cfgNs) { return cfgNs; }
  if (wsFolder) {
    const relDir = path.relative(wsFolder.uri.fsPath, path.dirname(docUri.fsPath)).replace(/\\/g, '/');
    if (relDir) {
      // e.g. "Resources" → "Resources.Strings"
      return `${toPascalCase(relDir)}.${stem}`;
    }
    // File is at workspace root
    return stem;
  }
  return stem;
}

function determineSecondNamespace(
  existing: string,
  config: vscode.WorkspaceConfiguration,
  docUri: vscode.Uri,
  wsFolder: vscode.WorkspaceFolder | undefined,
  stem: string,
): string {
  if (existing) { return existing; }
  const cfgNs = config.get<string>('defaultNamespace', '');
  if (cfgNs) {
    const relDir = wsFolder
      ? path.relative(wsFolder.uri.fsPath, path.dirname(docUri.fsPath)).replace(/\\/g, '/')
      : '';
    if (relDir) {
      return `${cfgNs}.${toPascalCase(relDir)}.${stem}`;
    }
    return `${cfgNs}.${stem}`;
  }
  if (wsFolder) {
    const relDir = path.relative(wsFolder.uri.fsPath, path.dirname(docUri.fsPath)).replace(/\\/g, '/');
    const wsName = path.basename(wsFolder.uri.fsPath);
    if (relDir) {
      return `${toPascalCase(relDir)}.${stem}`;
    }
    return stem;
  }
  return stem;
}

function toPascalCase(s: string): string {
  return s.split(/[/\\]/).map(seg => {
    // Convert kebab-case or snake_case segments
    return seg.split(/[-_]/).map(part =>
      part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    ).join('');
  }).join('.');
}

function generateDesignerCsContent(
  stem: string,
  rootNs: string,
  secondNs: string,
  names: string[],
  version: string,
): string {
  const eol = '\r\n';
  const lines: string[] = [
    `namespace ${rootNs} {`,
    `    using System;`,
    `    [global::System.CodeDom.Compiler.GeneratedCodeAttribute("hetima.resx-designer", "${version}")]`,
    `    [global::System.Diagnostics.DebuggerNonUserCodeAttribute()]`,
    `    [global::System.Runtime.CompilerServices.CompilerGeneratedAttribute()]`,
    `    public class ${stem} {`,
    ``,
    `        private static global::System.Resources.ResourceManager resourceMan;`,
    ``,
    `        private static global::System.Globalization.CultureInfo resourceCulture;`,
    ``,
    `        [global::System.Diagnostics.CodeAnalysis.SuppressMessageAttribute("Microsoft.Performance", "CA1811:AvoidUncalledPrivateCode")]`,
    `        internal ${stem}() {`,
    `        }`,
    ``,
    `        [global::System.ComponentModel.EditorBrowsableAttribute(global::System.ComponentModel.EditorBrowsableState.Advanced)]`,
    `        public static global::System.Resources.ResourceManager ResourceManager {`,
    `            get {`,
    `                if (object.ReferenceEquals(resourceMan, null)) {`,
    `                    global::System.Resources.ResourceManager temp = new global::System.Resources.ResourceManager("${secondNs}", typeof(${stem}).Assembly);`,
    `                    resourceMan = temp;`,
    `                }`,
    `                return resourceMan;`,
    `            }`,
    `        }`,
    ``,
    `        [global::System.ComponentModel.EditorBrowsableAttribute(global::System.ComponentModel.EditorBrowsableState.Advanced)]`,
    `        public static global::System.Globalization.CultureInfo Culture {`,
    `            get {`,
    `                return resourceCulture;`,
    `            }`,
    `            set {`,
    `                resourceCulture = value;`,
    `            }`,
    `        }`,
  ];

  for (const name of names) {
    lines.push('');
    lines.push(`        internal static string ${name} {`);
    lines.push(`            get {`);
    lines.push(`                return ResourceManager.GetString("${name}", resourceCulture);`);
    lines.push(`            }`);
    lines.push(`        }`);
  }

  lines.push('');
  lines.push('    }');
  lines.push('}');

  return lines.join(eol) + eol;
}

export function deactivate() {}
