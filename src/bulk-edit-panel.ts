import * as vscode from 'vscode';
import { BulkEditCustomEditorProvider } from './BulkEditCustomEditorProvider';

// ── Public API ──────────────────────────────────────────────────────

/**
 * Open a bulk-edit custom editor for a specific resource key.
 * Creates a temp file (.resxbulk) and opens it with the custom editor provider.
 *
 * @param context  Extension context (for globalStorageUri, etc.)
 * @param uri      URI of any .resx file in the locale set (used to discover related files)
 * @param name     The resource key to bulk-edit across all locales
 */
export async function openBulkEditPanel(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
  name: string,
): Promise<void> {
  try {
    const tmpUri = await BulkEditCustomEditorProvider.createTempFile(context, uri, name);
    await vscode.commands.executeCommand(
      'vscode.openWith',
      tmpUri,
      BulkEditCustomEditorProvider.viewType,
      { viewColumn: vscode.ViewColumn.Beside }
    );
  } catch (err) {
    console.error('[bulkEdit] failed to open panel', err);
    vscode.window.showErrorMessage(
      `RESX: Failed to open bulk-edit panel for "${name}".`
    );
  }
}
