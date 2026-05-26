import * as path from 'path';
import * as vscode from 'vscode';
import { parseResxFilename } from './resx-locale-finder';
import {
  YamlEditMetadata,
  createYamlTempFile,
  buildSingleYaml,
  buildBulkYaml,
  buildMultiYaml,
} from './resx-yaml';

export async function openSingleYamlEdit(
  context: vscode.ExtensionContext,
  sourceUri: vscode.Uri,
): Promise<void> {
  try {
    const { yaml } = await buildSingleYaml(sourceUri);
    const metadata: YamlEditMetadata = {
      mode: 'single',
      sourceUri: sourceUri.toString(),
    };
    const tmpUri = await createYamlTempFile(context, metadata, yaml);
    await vscode.commands.executeCommand('vscode.open', tmpUri, {
      viewColumn: vscode.ViewColumn.Active,
    });
  } catch (err) {
    vscode.window.showErrorMessage(`RESX: Failed to open YAML editor. ${err}`);
  }
}

export async function openBulkYamlEdit(
  context: vscode.ExtensionContext,
  sourceUri: vscode.Uri,
  keyName: string,
): Promise<void> {
  try {
    const { yaml } = await buildBulkYaml(sourceUri, keyName);
    const metadata: YamlEditMetadata = {
      mode: 'bulk',
      sourceUri: sourceUri.toString(),
      keyName,
    };
    const tmpUri = await createYamlTempFile(context, metadata, yaml);
    await vscode.commands.executeCommand('vscode.open', tmpUri, {
      viewColumn: vscode.ViewColumn.Beside,
    });
  } catch (err) {
    vscode.window.showErrorMessage(`RESX: Failed to open bulk YAML editor for "${keyName}". ${err}`);
  }
}

export async function openMultiYamlEdit(
  context: vscode.ExtensionContext,
  sourceUri: vscode.Uri,
): Promise<void> {
  try {
    // Normalize to default locale file
    const { baseName } = parseResxFilename(path.basename(sourceUri.fsPath));
    const defaultUri = vscode.Uri.file(path.join(path.dirname(sourceUri.fsPath), baseName));

    const { yaml } = await buildMultiYaml(defaultUri);
    const metadata: YamlEditMetadata = {
      mode: 'multi',
      sourceUri: defaultUri.toString(),
    };
    const tmpUri = await createYamlTempFile(context, metadata, yaml);
    await vscode.commands.executeCommand('vscode.open', tmpUri, {
      viewColumn: vscode.ViewColumn.Active,
    });
  } catch (err) {
    vscode.window.showErrorMessage(`RESX: Failed to open multi YAML editor. ${err}`);
  }
}
