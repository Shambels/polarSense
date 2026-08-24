import { parquetMetadataAsync, parquetSchema } from 'hyparquet';
import type { Column, ColumnStats } from '../core/types.js';
import type { Storage } from '../storage/index.js';
import { parquetDtype, type ParquetNode } from './dtypes.js';

export interface ParquetSchemaResult {
  columns: Column[];
  rowCount: number;
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
  const raw = indexStatistics(metadata);

  const columns = schema.children.map((child) => {
    const dtype = parquetDtype(child);
    return {
      name: child.element.name,
      dtype,
      stats: finish(raw.get(child.element.name), dtype)
    };
  });

  return { columns, rowCount: Number(metadata.num_rows ?? 0) };
}

interface RawStats {
  nullCount?: number;
  min?: unknown;
  max?: unknown;
}

/** One pass over every row group, folding each column's statistics together. */
function indexStatistics(metadata: { row_groups?: unknown[] }): Map<string, RawStats> {
  const out = new Map<string, RawStats>();

  for (const group of metadata.row_groups ?? []) {
    const columns = (group as { columns?: unknown[] }).columns ?? [];
    for (const column of columns) {
      const meta = (column as { meta_data?: Record<string, unknown> }).meta_data;
      const pathInSchema = meta?.['path_in_schema'];
      // Only top-level leaves: a nested list's element stats are not the column's.
      if (!Array.isArray(pathInSchema) || pathInSchema.length !== 1) continue;
      const stats = meta?.['statistics'] as Record<string, unknown> | undefined;
      if (!stats) continue;

      const name = String(pathInSchema[0]);
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
  return out;
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

export async function readIpcSchema(storage: Storage, uri: string): Promise<Column[]> {
  // Arrow IPC carries its schema in a flatbuffer at the head of the file. Rather
  // than pull in a full Arrow implementation for the one format nobody asked
  // about, report nothing and let the caller fall through cleanly.
  void storage;
  void uri;
  return [];
}
