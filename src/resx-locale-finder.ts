import * as vscode from 'vscode';
import * as path from 'path';
import { ResxLocaleSet, ResxDocument } from './types/resx';
import { parseResx } from './resx-parser';

/**
 * Extract locale and base-name from a .resx filename.
 *
 * Convention:
 *   Resources.resx       → { locale: null,  base: "Resources.resx" }
 *   Resources.ja.resx    → { locale: "ja",   base: "Resources.resx" }
 *   Resources.en-US.resx → { locale: "en-US", base: "Resources.resx" }
 *
 * The locale portion is everything between the base name and the final ".resx".
 * We also handle BCP-47 style codes with hyphens (e.g. zh-Hans, pt-BR).
 */
export function parseResxFilename(fileName: string): { locale: string | null; baseName: string } {
  if (!fileName.toLowerCase().endsWith('.resx')) {
    return { locale: null, baseName: fileName };
  }

  // Strip the ".resx" suffix
  const stem = fileName.slice(0, -5); // e.g. "Resources.ja"
  const parts = stem.split('.');

  // Need at least 2 parts (basename + resx): "Resources" → no locale
  // "Resources.ja" → locale "ja", base "Resources"
  // "My.Strings.ja" → locale "ja", base "My.Strings"
  if (parts.length <= 1) {
    return { locale: null, baseName: fileName };
  }

  // The candidate locale is the last segment; check if it looks like a locale tag.
  // A locale tag starts with a 2-3 letter code optionally followed by hyphens.
  const candidate = parts[parts.length - 1];
  const localeRe = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]+)*$/;
  if (localeRe.test(candidate)) {
    const baseParts = parts.slice(0, -1);
    return { locale: candidate, baseName: baseParts.join('.') + '.resx' };
  }

  return { locale: null, baseName: fileName };
}

/**
 * Find all .resx files related to the given file using folder convention.
 * Groups by base name within the same directory.
 */
export async function findRelatedResxFiles(
  uri: vscode.Uri
): Promise<ResxLocaleSet | null> {
  const dir = path.dirname(uri.fsPath);
  const fileName = path.basename(uri.fsPath);
  const { baseName } = parseResxFilename(fileName);

  // List all .resx files in the same directory
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
  } catch {
    return null;
  }

  const resxFiles = entries
    .filter(([name]) => name.toLowerCase().endsWith('.resx'))
    .map(([name]) => name);

  // Group by base name
  const related: Map<string | null, ResxDocument> = new Map();

  for (const resxName of resxFiles) {
    const parsed = parseResxFilename(resxName);
    if (parsed.baseName.toLowerCase() !== baseName.toLowerCase()) {
      continue; // different resource set
    }

    const fullPath = path.join(dir, resxName);
    try {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
      const xmlText = new TextDecoder('utf-8').decode(content);
      const doc = parseResx(xmlText, fullPath);
      doc.locale = parsed.locale;
      related.set(parsed.locale, doc);
    } catch (e) {
      console.warn(`RESX: failed to read/parse ${fullPath}`, e);
    }
  }

  if (related.size === 0) {
    return null;
  }

  return {
    baseDir: dir,
    baseName,
    locales: related,
  };
}

/**
 * Get the sorted list of locale keys for a locale set.
 * Order: default (null) → current locale → remaining locales (alphabetical).
 * @param set - The locale set to sort.
 * @param currentLocale - The locale of the currently open file (placed right after default).
 */
export function getSortedLocales(set: ResxLocaleSet, currentLocale: string | null): Array<string | null> {
  const keys = Array.from(set.locales.keys());
  keys.sort((a, b) => {
    if (a === null && b === null) return 0;
    if (a === null) return -1;
    if (b === null) return 1;
    // Place currentLocale immediately after default
    if (a === currentLocale && b !== currentLocale) return -1;
    if (b === currentLocale && a !== currentLocale) return 1;
    return (a as string).localeCompare(b as string);
  });
  return keys;
}
