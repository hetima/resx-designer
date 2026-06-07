import * as path from 'path';
import * as crypto from 'crypto';
import { ResxDocument, ResxEntry, ResxLocaleSet } from './types/resx';
import { parseResx } from './resx-parser';
import { findRelatedResxFiles, getSortedLocales, parseResxFilename } from './resx-locale-finder';
import * as vscode from 'vscode';

// ── YAML serialization ────────────────────────────────────────────────

function yamlScalar(s: string): string {
  // Use double-quoted string if value contains special chars or is empty
  if (s === '') { return '""'; }
  if (/[\r\n:"#&*?|<>{}[\],]/.test(s) || /^\s|\s$/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
  }
  return s;
}

/** Single .resx → YAML */
export function singleResxToYaml(doc: ResxDocument): string {
  const lines: string[] = [];
  for (const entry of doc.entries) {
    if (entry.comment) {
      lines.push(`${yamlScalar(entry.name)}:`);
      lines.push(`  value: ${yamlScalar(entry.value)}`);
      lines.push(`  comment: ${yamlScalar(entry.comment)}`);
      lines.push('');
    } else {
      lines.push(`${yamlScalar(entry.name)}: ${yamlScalar(entry.value)}`);
    }
  }
  return lines.join('\n');
}

/** Locale set (bulk: single key across locales) → YAML */
export function bulkResxToYaml(localeSet: ResxLocaleSet, keyName: string): string {
  const sortedLocales = getSortedLocales(localeSet, null);
  const lines: string[] = [];
  lines.push(`${yamlScalar(keyName)}:`);
  for (const loc of sortedLocales) {
    const doc = localeSet.locales.get(loc);
    if (!doc) { continue; }
    const entry = doc.entries.find(e => e.name === keyName);
    const value = entry?.value ?? '';
    const label = loc === null ? 'default' : loc;
    lines.push(`  ${yamlScalar(label)}: ${yamlScalar(value)}`);
  }
  // comment from default locale
  const defaultDoc = localeSet.locales.get(null);
  const defaultEntry = defaultDoc?.entries.find(e => e.name === keyName);
  if (defaultEntry?.comment) {
    lines.push(`  comment: ${yamlScalar(defaultEntry.comment)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Locale set (multi: all keys across locales) → YAML */
export function multiResxToYaml(localeSet: ResxLocaleSet): string {
  const sortedLocales = getSortedLocales(localeSet, null);

  // Collect key order from all locales (default first)
  const nameOrder: string[] = [];
  const nameSet = new Set<string>();
  for (const loc of sortedLocales) {
    const doc = localeSet.locales.get(loc);
    if (!doc) { continue; }
    for (const entry of doc.entries) {
      if (!nameSet.has(entry.name)) {
        nameSet.add(entry.name);
        nameOrder.push(entry.name);
      }
    }
  }

  const lines: string[] = [];
  for (const name of nameOrder) {
    lines.push(`${yamlScalar(name)}:`);
    for (const loc of sortedLocales) {
      const doc = localeSet.locales.get(loc);
      if (!doc) { continue; }
      const entry = doc.entries.find(e => e.name === name);
      const value = entry?.value ?? '';
      const label = loc === null ? 'default' : loc;
      lines.push(`  ${yamlScalar(label)}: ${yamlScalar(value)}`);
    }
    // comment from default locale
    const defaultDoc = localeSet.locales.get(null);
    const defaultEntry = defaultDoc?.entries.find(e => e.name === name);
    if (defaultEntry?.comment) {
      lines.push(`  comment: ${yamlScalar(defaultEntry.comment)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ── YAML parsing ──────────────────────────────────────────────────────

function parseYamlScalar(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    if (s.startsWith('"')) {
      return inner
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    return inner.replace(/''/g, "'");
  }
  return s;
}

interface ParsedYamlEntry {
  name: string;
  inlineValue?: string; // value on the same line as the key (flat form: Key: value)
  fields: Map<string, string>; // label → value (including 'value', 'comment', locale codes)
}

function parseYaml(yaml: string): ParsedYamlEntry[] {
  const entries: ParsedYamlEntry[] = [];
  let current: ParsedYamlEntry | null = null;

  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.trimEnd();
    if (line === '' || line.trimStart().startsWith('#')) { continue; }

    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      // Top-level key
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) { continue; }
      const name = parseYamlScalar(line.slice(0, colonIdx).trim());
      const rest = line.slice(colonIdx + 1).trim();
      current = { name, fields: new Map() };
      if (rest) { current.inlineValue = parseYamlScalar(rest); }
      entries.push(current);
    } else if (current) {
      // Indented field
      const trimmed = line.trimStart();
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx < 0) { continue; }
      const fieldKey = parseYamlScalar(trimmed.slice(0, colonIdx).trim());
      const fieldVal = parseYamlScalar(trimmed.slice(colonIdx + 1).trim());
      current.fields.set(fieldKey, fieldVal);
    }
  }
  return entries;
}

export function countYamlEntries(yaml: string): number {
  return parseYaml(yaml).length;
}

/** YAML → single ResxDocument entries (merges into existing doc) */
export function yamlToSingleResx(yaml: string, existingDoc: ResxDocument): ResxDocument {
  const parsed = parseYaml(yaml);
  const entries: ResxEntry[] = parsed.map(e => ({
    name: e.name,
    value: e.inlineValue ?? e.fields.get('value') ?? '',
    comment: e.fields.get('comment') ?? '',
  }));
  return { ...existingDoc, entries };
}

/** YAML → bulk update: apply locale values for keyName across localeSet */
export function yamlToBulkResx(yaml: string, localeSet: ResxLocaleSet, keyName: string): ResxDocument[] {
  const parsed = parseYaml(yaml);
  const entry = parsed.find(e => e.name === keyName);
  if (!entry) { return []; }

  const changedDocs: ResxDocument[] = [];
  for (const [loc, doc] of localeSet.locales) {
    const label = loc === null ? 'default' : loc;
    if (!entry.fields.has(label)) { continue; }
    const newValue = entry.fields.get(label)!;
    if (newValue === '') { continue; }
    const existing = doc.entries.find(e => e.name === keyName);
    if (existing) {
      const newComment = loc === null && entry.fields.has('comment')
        ? entry.fields.get('comment')!
        : existing.comment;
      if (existing.value === newValue && existing.comment === newComment) { continue; }
      existing.value = newValue;
      if (loc === null && entry.fields.has('comment')) {
        existing.comment = entry.fields.get('comment')!;
      }
    } else {
      doc.entries.push({
        name: keyName,
        value: newValue,
        comment: loc === null ? (entry.fields.get('comment') ?? '') : '',
      });
    }
    changedDocs.push(doc);
  }
  return changedDocs;
}

/** YAML → multi update: apply all keys across localeSet */
export function yamlToMultiResx(yaml: string, localeSet: ResxLocaleSet): void {
  const parsed = parseYaml(yaml);

  for (const parsedEntry of parsed) {
    const name = parsedEntry.name;
    for (const [loc, doc] of localeSet.locales) {
      const label = loc === null ? 'default' : loc;
      if (!parsedEntry.fields.has(label)) { continue; }
      const newValue = parsedEntry.fields.get(label)!;
      const existing = doc.entries.find(e => e.name === name);
      if (existing) {
        existing.value = newValue;
        if (loc === null && parsedEntry.fields.has('comment')) {
          existing.comment = parsedEntry.fields.get('comment')!;
        }
      } else {
        doc.entries.push({
          name,
          value: newValue,
          comment: loc === null ? (parsedEntry.fields.get('comment') ?? '') : '',
        });
      }
    }
  }

  // Handle key deletions: remove keys not in YAML from all locales
  const yamlNames = new Set(parsed.map(e => e.name));
  for (const [, doc] of localeSet.locales) {
    doc.entries = doc.entries.filter(e => yamlNames.has(e.name));
  }
}

// ── Metadata stored in temp file ──────────────────────────────────────

export type YamlEditMode = 'single' | 'bulk' | 'multi';

export interface YamlEditMetadata {
  mode: YamlEditMode;
  /** URI of the source .resx file */
  sourceUri: string;
  /** For bulk mode: the resource key being edited */
  keyName?: string;
  /** True when closed gracefully */
  closed?: boolean;
}

// ── Temp file utilities ───────────────────────────────────────────────

const TEMP_DIR_NAME = 'yaml-edit';
const TEMP_EXT = '.resxyaml';

export async function ensureYamlTempDir(context: vscode.ExtensionContext): Promise<vscode.Uri> {
  const base = context.storageUri ?? context.globalStorageUri;
  const dir = vscode.Uri.file(path.join(base.fsPath, TEMP_DIR_NAME));
  try { await vscode.workspace.fs.createDirectory(dir); } catch { /* already exists */ }
  return dir;
}

function sourceHash(sourceUri: string): string {
  return crypto.createHash('sha1').update(sourceUri).digest('hex').slice(0, 8);
}

export async function createYamlTempFile(
  context: vscode.ExtensionContext,
  metadata: YamlEditMetadata,
  content: string,
): Promise<vscode.Uri> {
  const baseDir = await ensureYamlTempDir(context);
  const subDir = vscode.Uri.file(path.join(baseDir.fsPath, sourceHash(metadata.sourceUri)));
  try { await vscode.workspace.fs.createDirectory(subDir); } catch { /* already exists */ }
  const sourceBase = path.basename(vscode.Uri.parse(metadata.sourceUri).fsPath);
  const prefix = metadata.mode === 'bulk' ? '[Bulk]' : metadata.mode === 'multi' ? '[Multi]' : '';
  const keySuffix = metadata.keyName ? `_${metadata.keyName}` : '';
  const fileName = `${prefix ? prefix + ' ' : ''}${sourceBase}${keySuffix}${TEMP_EXT}`;
  const tmpUri = vscode.Uri.file(path.join(subDir.fsPath, fileName));

  // Write content (yaml text) into the temp file
  await vscode.workspace.fs.writeFile(tmpUri, new TextEncoder().encode(content));

  // Write metadata sidecar
  await vscode.workspace.fs.writeFile(
    sidecarUri(tmpUri),
    new TextEncoder().encode(JSON.stringify(metadata, null, 2))
  );

  return tmpUri;
}

export async function readYamlTempMetadata(tmpUri: vscode.Uri): Promise<YamlEditMetadata | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(sidecarUri(tmpUri));
    return JSON.parse(new TextDecoder().decode(bytes)) as YamlEditMetadata;
  } catch {
    return null;
  }
}

export async function markYamlTempClosed(tmpUri: vscode.Uri): Promise<void> {
  const meta = await readYamlTempMetadata(tmpUri);
  if (!meta) { return; }
  meta.closed = true;
  await vscode.workspace.fs.writeFile(
    sidecarUri(tmpUri),
    new TextEncoder().encode(JSON.stringify(meta, null, 2))
  );
}

function sidecarUri(tmpUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.file(tmpUri.fsPath + '.meta.json');
}

export async function scanAllYamlTempFiles(
  context: vscode.ExtensionContext
): Promise<Array<{ uri: vscode.Uri; metadata: YamlEditMetadata }>> {
  const dir = await ensureYamlTempDir(context);
  const results: Array<{ uri: vscode.Uri; metadata: YamlEditMetadata }> = [];
  try {
    const topEntries = await vscode.workspace.fs.readDirectory(dir);
    for (const [topName, topType] of topEntries) {
      if (topType !== vscode.FileType.Directory) { continue; }
      const subDir = vscode.Uri.file(path.join(dir.fsPath, topName));
      try {
        const entries = await vscode.workspace.fs.readDirectory(subDir);
        for (const [name, type] of entries) {
          if (type !== vscode.FileType.File || !name.endsWith(TEMP_EXT)) { continue; }
          const uri = vscode.Uri.file(path.join(subDir.fsPath, name));
          const meta = await readYamlTempMetadata(uri);
          if (meta?.sourceUri) {
            results.push({ uri, metadata: meta });
          }
        }
      } catch { /* subdir read failed */ }
    }
  } catch { /* dir read failed */ }
  return results;
}

export async function deleteYamlTempFile(tmpUri: vscode.Uri): Promise<void> {
  try { await vscode.workspace.fs.delete(tmpUri); } catch { /* ignore */ }
  try { await vscode.workspace.fs.delete(sidecarUri(tmpUri)); } catch { /* ignore */ }
}

// ── Open helpers (build YAML content from live files) ────────────────

export async function buildSingleYaml(sourceUri: vscode.Uri): Promise<{ yaml: string; doc: ResxDocument }> {
  const bytes = await vscode.workspace.fs.readFile(sourceUri);
  const xml = new TextDecoder('utf-8').decode(bytes);
  const doc = parseResx(xml, sourceUri.fsPath);
  doc.locale = parseResxFilename(path.basename(sourceUri.fsPath)).locale;
  return { yaml: singleResxToYaml(doc), doc };
}

export async function buildBulkYaml(sourceUri: vscode.Uri, keyName: string): Promise<{ yaml: string; localeSet: ResxLocaleSet }> {
  const localeSet = await findRelatedResxFiles(sourceUri);
  if (!localeSet) { throw new Error(`Could not find locale files for "${sourceUri.fsPath}".`); }
  const yaml = bulkResxToYaml(localeSet, keyName);
  return { yaml, localeSet };
}

export async function buildMultiYaml(sourceUri: vscode.Uri): Promise<{ yaml: string; localeSet: ResxLocaleSet }> {
  const localeSet = await findRelatedResxFiles(sourceUri);
  if (!localeSet) { throw new Error(`Could not find locale files for "${sourceUri.fsPath}".`); }
  const yaml = multiResxToYaml(localeSet);
  return { yaml, localeSet };
}
