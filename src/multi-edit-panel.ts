import * as vscode from 'vscode';
import { MultiEditCustomEditorProvider } from './MultiEdit';

// ── Public API ──────────────────────────────────────────────────────

/**
 * Open a multi-edit custom editor showing all keys across all locales.
 * Creates a temp file (.resxmulti) and opens it with the custom editor provider.
 *
 * @param context  Extension context (for globalStorageUri, etc.)
 * @param uri      URI of the default .resx file (locale=null) in the locale set
 */
export async function openMultiEditPanel(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
): Promise<void> {
  try {
    const tmpUri = await MultiEditCustomEditorProvider.createTempFile(context, uri);
    await vscode.commands.executeCommand(
      'vscode.openWith',
      tmpUri,
      MultiEditCustomEditorProvider.viewType,
      { viewColumn: vscode.ViewColumn.Active }
    );
  } catch (err) {
    console.error('[multiEdit] failed to open panel', err);
    vscode.window.showErrorMessage(
      `RESX: Failed to open multi-edit panel.`
    );
  }
}
