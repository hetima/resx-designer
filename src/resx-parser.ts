import { ResxDocument, ResxEntry } from './types/resx';

/**
 * Parse a .resx XML string into a ResxDocument.
 *
 * We deliberately avoid pulling in a heavyweight XML library and instead
 * use a small hand-rolled state-machine parser that is sufficient for the
 * very regular shape of .resx files.  The <data> element may contain
 * <value> and <comment> children.  Everything else (<metadata>,
 * <resheader>, assembly nodes, …) is silently ignored.
 */
export function parseResx(xmlText: string, filePath: string): ResxDocument {
  const entries: ResxEntry[] = [];

  // Bookmark the XML declaration / root attributes so we can round-trip them.
  // We keep everything verbatim except the bodies of <data> elements.
  const xmlDeclarationMatch = xmlText.match(/(<\?xml[^?]*\?>)/);
  const xmlDeclaration = xmlDeclarationMatch ? xmlDeclarationMatch[1] : '<?xml version="1.0" encoding="utf-8"?>';

  // Regex-based extraction — sufficient for well-formed .resx (Microsoft tooling output).
  // Each <data> element may span multiple lines; we use a non-greedy match.
  const dataRe = /<data\s+([^>]*?)>([\s\S]*?)<\/data>/g;
  let m: RegExpExecArray | null;

  while ((m = dataRe.exec(xmlText)) !== null) {
    const attrs = m[1];
    const body = m[2];

    // Extract name attribute
    const nameMatch = attrs.match(/name\s*=\s*"([^"]*)"/) ?? attrs.match(/name\s*=\s*'([^']*)'/);
    const name = nameMatch ? decodeXmlEntities(nameMatch[1]) : '';
    if (name === '') { continue; } // skip entries without a name

    // Skip non-string types (e.g. type="System.Drawing.Bitmap, …")
    const typeMatch = attrs.match(/type\s*=\s*"([^"]*)"/) ?? attrs.match(/type\s*=\s*'([^']*)'/);
    if (typeMatch) { continue; }
    // Also skip mimetype-presence (embedded objects)
    const mimeMatch = attrs.match(/mimetype\s*=\s*"([^"]*)"/) ?? attrs.match(/mimetype\s*=\s*'([^']*)'/);
    if (mimeMatch) { continue; }

    // Extract <value>
    const valueMatch = body.match(/<value>([\s\S]*?)<\/value>/);
    const value = valueMatch ? decodeXmlEntities(valueMatch[1].trim()) : '';

    // Extract <comment>
    const commentMatch = body.match(/<value>\s*([\s\S]*?)\s*<\/value>[\s\S]*?<comment>([\s\S]*?)<\/comment>/);
    const commentMatch2 = body.match(/<comment>([\s\S]*?)<\/comment>/);
    const comment = commentMatch2 ? decodeXmlEntities(commentMatch2[1].trim()) : '';

    entries.push({ name, value, comment });
  }

  return { path: filePath, locale: null, entries };
}

// ── XML entity helpers ──────────────────────────────────────────────

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

const AMP_RE = /&(#?\w+;?)/g;

function decodeXmlEntities(s: string): string {
  return s.replace(AMP_RE, (entity) => ENTITY_MAP[entity] ?? entity);
}

export function encodeXmlEntities(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
