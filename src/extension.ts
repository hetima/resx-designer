import * as path from 'path';
import * as vscode from 'vscode';
import { ResxEditorProvider } from './ResxEditorProvider';
import { BulkEditCustomEditorProvider } from './BulkEditCustomEditorProvider';
import type { BulkEditTempFileMetadata } from './types/resx';
import { registerResxCommands } from './commands';
import { parseResx } from './resx-parser';
import { isDefaultResx } from './resx-config';

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

  // Register the bulk-edit custom editor provider
  const bulkProvider = new BulkEditCustomEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(BulkEditCustomEditorProvider.viewType, bulkProvider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    })
  );

  // Clean up bulk-edit temp files: delete closed ones, auto-restore unclosed (crash recovery)
  cleanTempFiles(context);

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

  // ── Auto-generate Designer.cs on .resx change ────────────────────
  // FileSystemWatcher catches both VS Code saves and external edits (CLI-AI, etc.)
  if (vscode.workspace.workspaceFolders) {
    for (const wsFolder of vscode.workspace.workspaceFolders) {
      const pattern = new vscode.RelativePattern(wsFolder, '**/*.resx');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(async (uri) => {
        await tryRegenerateDesignerCs(uri, extensionVersion);
      });
      context.subscriptions.push(watcher);
    }
  }
}

// ── Designer.cs Generation ─────────────────────────────────────────

/** Check if uri matches any configured defaultResx, then regenerate. */
async function tryRegenerateDesignerCs(
  uri: vscode.Uri,
  extensionVersion: string,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('resx', uri);

  const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
  const relativePath = wsFolder
    ? path.relative(wsFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/')
    : path.basename(uri.fsPath);

  if (!isDefaultResx(relativePath, config)) { return; }

  // Read file content from disk (works for both VS Code saves and external edits)
  const bytes = await vscode.workspace.fs.readFile(uri);
  const xmlText = new TextDecoder('utf-8').decode(bytes);

  await regenerateDesignerCs(uri, xmlText, wsFolder, config, extensionVersion);
}

async function regenerateDesignerCs(
  docUri: vscode.Uri,
  xmlText: string,
  wsFolder: vscode.WorkspaceFolder | undefined,
  config: vscode.WorkspaceConfiguration,
  extensionVersion: string,
): Promise<void> {
  try {
    const stem = path.basename(docUri.fsPath, '.resx');
    const resxDir = path.dirname(docUri.fsPath);
    const outputPath = path.join(resxDir, `${stem}.Designer.cs`);
    const outputUri = vscode.Uri.file(outputPath);

    // 1. Read resx names
    const resxDoc = parseResx(xmlText, docUri.fsPath);
    const resxNames = resxDoc.entries.map(e => e.name).sort();

    // 2. Read existing Designer.cs if present
    let existingNames: string[] = [];
    let existingRootNs = '';
    let existingSecondNs = '';
    try {
      const existingBytes = await vscode.workspace.fs.readFile(outputUri);
      const text = new TextDecoder('utf-8').decode(existingBytes);
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
    const rootNs = determineRootNamespace(existingRootNs, config, docUri, wsFolder, stem);
    const secondNs = determineSecondNamespace(existingSecondNs, config, docUri, wsFolder, stem);

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

// ── Bulk-Edit Temp File Cleanup ──────────────────────────────────────

async function cleanTempFiles(context: vscode.ExtensionContext): Promise<void> {
  const all = await BulkEditCustomEditorProvider.scanAllTempFiles(context);
  if (all.length === 0) { return; }

  const toDelete: vscode.Uri[] = [];
  const toRestore: Array<{ uri: vscode.Uri; metadata: BulkEditTempFileMetadata }> = [];

  for (const item of all) {
    if (item.metadata.closed) {
      toDelete.push(item.uri);
    } else {
      toRestore.push(item);
    }
  }

  // Delete closed files silently
  if (toDelete.length > 0) {
    await BulkEditCustomEditorProvider.deleteOrphanedFiles(context, toDelete);
  }

  // Auto-restore unclosed files (crash recovery — no prompt needed)
  for (const { uri, metadata } of toRestore) {
    try {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        BulkEditCustomEditorProvider.viewType,
        { viewColumn: vscode.ViewColumn.Beside }
      );
    } catch {
      // could not restore — leave for next startup
    }
  }
}

export function deactivate() {}
