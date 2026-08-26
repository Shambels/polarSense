import { inflateRawSync } from 'node:zlib';
import type { Column } from '../core/types.js';
import type { Storage } from '../storage/index.js';

/**
 * `.xlsx` is a zip of XML, so the header row is a zip read plus two regexes —
 * and node's own `inflateRawSync` decodes the one method a spreadsheet writer
 * ever uses, which is why this costs no dependency at all.
 *
 * `.xls` is not this format. It is OLE2, a different binary container, and it
 * reports nothing rather than guessing.
 */

interface ZipEntry {
  method: number;
  compressedSize: number;
  localOffset: number;
}

export async function readExcelSchema(storage: Storage, uri: string): Promise<Column[]> {
  // ponytail: reads the whole workbook. The central directory lives at the end
  // and the sheet is somewhere in the middle, so a ranged read would be two
  // round trips for a file that is already compressed — revisit if a large
  // workbook ever makes this jank.
  const bytes = await storage.readAll(uri);
  const zip = readZip(bytes);

  // ponytail: first sheet only, and sheet1.xml rather than whatever workbook.xml
  // orders first. Right for everything polars, pandas and Excel write; add the
  // workbook.xml lookup the day `sheet_name=` needs to be honoured.
  const sheet = zip.get('xl/worksheets/sheet1.xml');
  if (!sheet) return [];

  const row = firstRow(readEntry(bytes, sheet));
  if (!row) return [];

  const table = zip.get('xl/sharedStrings.xml');
  const strings = table ? sharedStrings(readEntry(bytes, table)) : [];
  return headerColumns(row, strings);
}

/** Entries by name, read from the central directory rather than by scanning. */
function readZip(bytes: Uint8Array): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();
  if (bytes.length < 22) return entries;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record is last, behind a comment of up to 64K.
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return entries;

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  // ponytail: no zip64. Both sentinels mean a workbook past 4GB or 65535 parts,
  // which is not a spreadsheet anyone is completing columns against.
  if (count === 0xffff || offset === 0xffffffff) return entries;

  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < count && offset + 46 <= bytes.length; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    entries.set(decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)), {
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      localOffset: view.getUint32(offset + 42, true)
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(bytes: Uint8Array, entry: ZipEntry): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (at + 30 > bytes.length || view.getUint32(at, true) !== 0x04034b50) return '';

  // The local header repeats the name and extra fields at its own lengths — the
  // central directory's are allowed to differ, so these are the ones to trust.
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  try {
    const raw = entry.method === 0 ? data : inflateRawSync(data);
    return new TextDecoder('utf-8').decode(raw);
  } catch {
    return ''; // an unexpected codec, or a truncated member
  }
}

/** The first row that has cells in it. */
function firstRow(xml: string): string | null {
  return /<row\b[^>]*>([\s\S]*?)<\/row>/.exec(xml)?.[1] ?? null;
}

/** Each `<si>` is one string, possibly split into runs by rich-text formatting. */
function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => textOf(match[1]));
}

const CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

function headerColumns(row: string, strings: string[]): Column[] {
  const byIndex: string[] = [];

  for (const match of row.matchAll(CELL)) {
    const attributes = match[1];
    const body = match[2] ?? '';
    const reference = /\br="([A-Z]+)\d+"/.exec(attributes);
    const index = reference ? columnIndex(reference[1]) : byIndex.length;
    const type = /\bt="([^"]+)"/.exec(attributes)?.[1];

    if (type === 's') {
      const at = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1]);
      byIndex[index] = strings[at] ?? '';
    } else if (type === 'inlineStr' || type === 'str') {
      byIndex[index] = textOf(body);
    } else {
      byIndex[index] = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
    }
  }

  // Excel omits an empty cell entirely rather than writing a blank one, so the
  // gaps are holes in this array — named, not closed up, or every column after
  // a blank header would answer under its neighbour's name.
  return Array.from(byIndex, (name, i) => ({
    name: name && name.trim() !== '' ? name.trim() : `column_${i + 1}`,
    dtype: ''
  }));
}

/** "A" → 0, "B" → 1, "AA" → 26. */
function columnIndex(letters: string): number {
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function textOf(xml: string): string {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map((match) => unescapeXml(match[1]))
    .join('');
}

function unescapeXml(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
    (whole, dec: string, hex: string, named: string) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named] ?? whole;
    });
}
