import { ResxDocument, ResxEntry } from './types/resx';
import { encodeXmlEntities } from './resx-parser';

/**
 * Serialize a ResxDocument back to a valid .resx XML string.
 * The output follows the conventional Microsoft RESX schema layout
 * so that Visual Studio / .NET tooling can read it cleanly.
 */
export function serializeResx(doc: ResxDocument): string {
  const NL = '\r\n'; // .NET RESX files conventionally use \r\n
  const IND = '  ';
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push('<root>');

  // Standard RESX schema headers
  lines.push(`${IND}<!--`);
  lines.push(`${IND}  Microsoft ResX Schema`);
  lines.push(`${IND}`);
  lines.push(`${IND}  Version 2.0`);
  lines.push(`${IND}`);
  lines.push(`${IND}  The primary goals of this format is to allow a simple XML format`);
  lines.push(`${IND}  that is mostly human readable. The generation and parsing of the`);
  lines.push(`${IND}  various data types are done through the TypeConverter classes`);
  lines.push(`${IND}  associated with the data types.`);
  lines.push(`${IND}`);
  lines.push(`${IND}  Example:`);
  lines.push(`${IND}`);
  lines.push(`${IND}  ... ado.net/XML headers/schema ...`);
  lines.push(`${IND}  <resheader name="resmimetype">`);
  lines.push(`${IND}    <value>text/microsoft-resx</value>`);
  lines.push(`${IND}  </resheader>`);
  lines.push(`${IND}  <resheader name="version">`);
  lines.push(`${IND}    <value>2.0</value>`);
  lines.push(`${IND}  </resheader>`);
  lines.push(`${IND}  <resheader name="reader">`);
  lines.push(`${IND}    <value>System.Resources.ResXResourceReader, System.Windows.Forms, ...</value>`);
  lines.push(`${IND}  </resheader>`);
  lines.push(`${IND}  <resheader name="writer">`);
  lines.push(`${IND}    <value>System.Resources.ResXResourceWriter, System.Windows.Forms, ...</value>`);
  lines.push(`${IND}  </resheader>`);
  lines.push(`${IND}-->`);
  lines.push('');

  // Standard resheader entries (required for .NET tooling compatibility)
  lines.push(`${IND}<resheader name="resmimetype">`);
  lines.push(`${IND}${IND}<value>text/microsoft-resx</value>`);
  lines.push(`${IND}</resheader>`);
  lines.push(`${IND}<resheader name="version">`);
  lines.push(`${IND}${IND}<value>2.0</value>`);
  lines.push(`${IND}</resheader>`);
  lines.push(`${IND}<resheader name="reader">`);
  lines.push(`${IND}${IND}<value>System.Resources.ResXResourceReader, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value>`);
  lines.push(`${IND}</resheader>`);
  lines.push(`${IND}<resheader name="writer">`);
  lines.push(`${IND}${IND}<value>System.Resources.ResXResourceWriter, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value>`);
  lines.push(`${IND}</resheader>`);
  lines.push('');

  // Data entries
  for (const entry of doc.entries) {
    lines.push(serializeEntry(entry, IND));
    lines.push('');
  }

  lines.push('</root>');
  return lines.join(NL);
}

function serializeEntry(entry: ResxEntry, ind: string): string {
  const lines: string[] = [];
  lines.push(`${ind}<data name="${encodeXmlAttr(entry.name)}" xml:space="preserve">`);
  lines.push(`${ind}${ind}<value>${encodeXmlEntities(entry.value)}</value>`);
  if (entry.comment) {
    lines.push(`${ind}${ind}<comment>${encodeXmlEntities(entry.comment)}</comment>`);
  }
  lines.push(`${ind}</data>`);
  return lines.join('\r\n');
}

function encodeXmlAttr(s: string): string {
  return encodeXmlEntities(s).replace(/'/g, '&apos;');
}
