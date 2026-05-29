import * as vscode from 'vscode';
import * as path from 'path';

/** Normalize `resx.defaultResx` to a string array. */
export function normalizeDefaultResxList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return (raw as unknown[]).map(v => String(v)).filter(Boolean);
  }
  if (typeof raw === 'string' && raw) {
    return [raw];
  }
  return [];
}

/**
 * Check whether the given relative path matches any configured defaultResx,
 * or qualifies via the `Strings.resx` fallback convention.
 */
export function isDefaultResx(
  relativePath: string,
  config: vscode.WorkspaceConfiguration,
): boolean {
  const list = normalizeDefaultResxList(config.get<string | string[]>('defaultResx'))
    .map((p) => p.replace(/\\/g, '/'));
  if (list.some((p) => p === relativePath)) {
    return true;
  }
  // Fallback: unconfigured + filename is "Strings.resx"
  if (list.length === 0 && path.basename(relativePath) === 'Strings.resx') {
    return true;
  }
  return false;
}
