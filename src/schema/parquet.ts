import { parquetMetadataAsync, parquetSchema } from 'hyparquet';
import type { Column, ColumnStats } from '../core/types.js';
import type { Storage } from '../storage/index.js';
import { parquetDtype, type ParquetNode } from './dtypes.js';

export interface ParquetSchemaResult {
  columns: Column[];
  rowCount: number;
  /** Row groups in the file — the unit a paged read will eventually work in. */
  rowGroups: number;
  /** The codec its pages are written with, or all of them where they differ. */
  compression?: string;
}

/**
 * Two range reads and no decompression: the trailing bytes that hold the footer
 * length, then the footer itself. Cost is independent of how big the file is.
 *
 * The same footer already carries per-column statistics, so they come along free.
 */
export async function readParquetSchema(
  storage: Storage,
  uri: string
): Promise<ParquetSchemaResult> {
  const buffer = await storage.asyncBuffer(uri);
  const metadata = await parquetMetadataAsync(buffer);
  const schema = parquetSchema(metadata) as unknown as ParquetNode;

  // Index the row-group statistics once. Looking them up per column instead
  // would be quadratic, which a 5000-column file notices.
  const { stats: raw, codecs } = indexStatistics(metadata);
  const columns = schema.children.map((child) => toColumn(child, raw, ''));

  return {
    columns,
    rowCount: Number(metadata.num_rows ?? 0),
    rowGroups: metadata.row_groups?.length ?? 0,
    // A file written column by column can hold more than one codec. Naming both
    // is the honest answer where picking the first would be a guess.
    compression: [...codecs].sort().join(', ') || undefined
  };
}

/**
 * One column, and — when it is a struct — its own columns underneath. The
 * parquet schema is already a tree; keeping it is what lets `.struct.field("…")`
 * be answered at all.
 */
function toColumn(node: ParquetNode, raw: Map<string, RawStats>, prefix: string): Column {
  const name = node.element.name;
  const dtype = parquetDtype(node);
  // The prefix is carried as a string rather than a path array: a flat file
  // walks this 5000 times and should not pay for a join it does not need.
  const path = prefix ? `${prefix}.${name}` : name;
  const column: Column = { name, dtype, stats: finish(raw.get(path), dtype) };
  const children = structChildren(node);
  if (children) column.fields = children.map((child) => toColumn(child, raw, path));
  return column;
}

/**
 * The children of a plain struct group. A list and a map are groups too, and
 * their children are machinery — `list.element`, `key_value.key` — rather than
 * fields anyone would name.
 */
function structChildren(node: ParquetNode): ParquetNode[] | null {
  // Childless first: on a flat schema that is the only question worth asking,
  // and it is asked once per column.
  if (!node.children.length) return null;
  const logical = node.element.logical_type?.type;
  const converted = node.element.converted_type;
  if (logical === 'LIST' || converted === 'LIST') return null;
  if (logical === 'MAP' || converted === 'MAP') return null;
  return node.children;
}

interface RawStats {
  nullCount?: number;
  min?: unknown;
  max?: unknown;
}

/**
 * One pass over every row group, folding each column's statistics together —
 * and collecting the codecs on the way, since this is already the only walk of
 * the row groups and the details panel wants to name them.
 */
function indexStatistics(
  metadata: { row_groups?: unknown[] }
): { stats: Map<string, RawStats>; codecs: Set<string> } {
  const out = new Map<string, RawStats>();
  const codecs = new Set<string>();

  for (const group of metadata.row_groups ?? []) {
    const columns = (group as { columns?: unknown[] }).columns ?? [];
    for (const column of columns) {
      const meta = (column as { meta_data?: Record<string, unknown> }).meta_data;
      const codec = meta?.['codec'];
      if (typeof codec === 'string') codecs.add(codec.toLowerCase());
      const pathInSchema = meta?.['path_in_schema'];
      if (!Array.isArray(pathInSchema) || !pathInSchema.length) continue;
      const stats = meta?.['statistics'] as Record<string, unknown> | undefined;
      if (!stats) continue;

      // Keyed by the whole path, so a struct field finds its own statistics and
      // a list's `x.list.element` finds nothing looking for it. The flat case is
      // spelt out because a 5000-column file pays for this loop 5000 times.
      const name = pathInSchema.length === 1
        ? String(pathInSchema[0])
        : pathInSchema.map(String).join('.');
      const acc = out.get(name) ?? {};
      if (stats['null_count'] !== undefined && stats['null_count'] !== null) {
        acc.nullCount = (acc.nullCount ?? 0) + Number(stats['null_count']);
      }
      const lo = stats['min_value'] ?? stats['min'];
      const hi = stats['max_value'] ?? stats['max'];
      if (lo !== undefined && lo !== null && (acc.min === undefined || compare(lo, acc.min) < 0)) {
        acc.min = lo;
      }
      if (hi !== undefined && hi !== null && (acc.max === undefined || compare(hi, acc.max) > 0)) {
        acc.max = hi;
      }
      out.set(name, acc);
    }
  }
  return { stats: out, codecs };
}

function finish(raw: RawStats | undefined, dtype: string): ColumnStats | undefined {
  if (!raw) return undefined;
  return {
    nullCount: raw.nullCount,
    min: raw.min === undefined ? undefined : format(raw.min, dtype),
    max: raw.max === undefined ? undefined : format(raw.max, dtype)
  };
}

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const x = BigInt(a as bigint);
    const y = BigInt(b as bigint);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * hyparquet decodes DATE and TIMESTAMP statistics into Date objects, but other
 * writers emit the raw integer — days or micros since the epoch — which reads as
 * a meaningless number unless the dtype is applied. Handle both.
 */
function format(value: unknown, dtype: string): string {
  if (value instanceof Uint8Array) return '…';

  if (value instanceof Date) {
    const iso = value.toISOString();
    return dtype === 'date' ? iso.slice(0, 10) : iso.replace('T', ' ').replace('Z', '').slice(0, 23);
  }
  if (dtype === 'date' && (typeof value === 'number' || typeof value === 'bigint')) {
    return new Date(Number(value) * 86_400_000).toISOString().slice(0, 10);
  }
  if (dtype.startsWith('datetime') && (typeof value === 'number' || typeof value === 'bigint')) {
    const n = Number(value);
    const ms = dtype.includes('[ms') ? n : dtype.includes('[ns') ? n / 1e6 : n / 1000;
    return new Date(ms).toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
  }
  if (typeof value === 'string' && value.length > 40) return `${value.slice(0, 40)}…`;
  return String(value);
}
