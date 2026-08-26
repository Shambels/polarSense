import type { Column } from '../core/types.js';
import { readHead } from '../storage/local.js';
import { readHeadHttps } from '../storage/https.js';
import { schemeOf } from '../storage/index.js';

/**
 * JSON and NDJSON, through one scanner.
 *
 * The three shapes polars reads — an array of row objects, newline-delimited
 * objects, and a single object — are all just *top-level `{…}` runs in order*,
 * so none of them needs to be told apart from the others. That also means a
 * prefix of the file is enough: the scanner stops at whatever object the read
 * cut in half, rather than needing the closing bracket `JSON.parse` would want.
 */

/** Objects sampled before the column set is called final. */
const SAMPLE_ROWS = 50;

export async function readJsonSchema(uri: string, sniffBytes: number): Promise<Column[]> {
  const scheme = schemeOf(uri);
  const bytes = scheme === 'file'
    ? await readHead(uri, sniffBytes)
    : await readHeadHttps(uri, sniffBytes);

  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  return columnsOf(objectsIn(text, SAMPLE_ROWS));
}

/**
 * Balanced top-level `{…}` runs, parsed. Braces inside strings do not count,
 * which is the whole reason this is a scanner and not a regex; a run the read
 * truncated fails to parse and is dropped rather than ending the scan.
 */
function objectsIn(text: string, limit: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length && out.length < limit; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) continue; // stray closer: not our brace
      depth--;
      if (depth > 0 || start < 0) continue;
      try {
        const parsed: unknown = JSON.parse(text.slice(start, i + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Truncated by the prefix read, or simply not valid. Either way, skip it.
      }
      start = -1;
    }
  }
  return out;
}

/**
 * Keys in first-seen order, unioned across the sample, because polars unions
 * them too — a key absent from row 1 is still a column. The first row that has
 * a non-null value for a key decides its dtype; a key that is null everywhere
 * gets a blank one, on the same grounds as CSV with inference off.
 */
function columnsOf(rows: Record<string, unknown>[]): Column[] {
  const columns = new Map<string, Column>();
  for (const row of rows) {
    for (const [name, value] of Object.entries(row)) {
      const column = jsonColumn(name, value);
      const existing = columns.get(name);
      // Map.set keeps a key's original position, so first-seen order survives.
      if (!existing || !existing.dtype) { columns.set(name, column); continue; }
      // ponytail: numeric widening only. Once JSON is parsed there is no way to
      // tell 1.0 from 1, so a float column of whole numbers reads as i64 —
      // widen against the raw token if that ever bites.
      if (existing.dtype === 'i64' && column.dtype === 'f64') columns.set(name, column);
    }
  }
  return [...columns.values()];
}

function jsonColumn(name: string, value: unknown): Column {
  if (value === null || value === undefined) return { name, dtype: '' };
  if (typeof value === 'boolean') return { name, dtype: 'bool' };
  if (typeof value === 'number') {
    return { name, dtype: Number.isInteger(value) ? 'i64' : 'f64' };
  }
  if (typeof value === 'string') return { name, dtype: 'str' };
  if (Array.isArray(value)) {
    const first = value.find((v) => v !== null && v !== undefined);
    const inner = first === undefined ? '' : jsonColumn('', first).dtype;
    return { name, dtype: `list[${inner || 'null'}]` };
  }
  // A nested object is a struct, and it keeps its own columns — the tree every
  // other reader here produces, so `.struct.field("…")` answers for it too.
  const fields = columnsOf([value as Record<string, unknown>]);
  return { name, dtype: `struct[${fields.length}]`, fields };
}
