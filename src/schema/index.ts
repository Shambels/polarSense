import type { Column, Schema, SourceRef } from '../core/types.js';
import { storageFor, UnsupportedSchemeError, type Storage } from '../storage/index.js';
import { hiveValues, resolvePath, type PathContext } from '../paths.js';
import { readParquetSchema } from './parquet.js';
import { readIpcSchema } from './ipc.js';
import { readCsvSchema } from './csv.js';
import { readDeltaSchema } from './delta.js';
import { readIcebergSchema } from './iceberg.js';
import { readJsonSchema } from './json.js';
import { readExcelSchema } from './excel.js';
import { readParquetValues, type ValueSet } from './values.js';

export interface SchemaServiceOptions {
  cacheSize: number;
  maxColumns: number;
  httpsEnabled: boolean;
  csvSniffBytes: number;
  csvInferDtypes: boolean;
  /** Reading a column's values reads data, not metadata. Off until asked for. */
  valuesEnabled: boolean;
  valueMaxRows: number;
  valueMaxDistinct: number;
}

export interface SchemaResult {
  schema?: Schema;
  /** The concrete file we read, for the status bar and cache invalidation. */
  uri?: string;
  error?: 'file-not-found' | 'unsupported-scheme' | 'read-failed';
  /** Which cache entry answered, so values can be hung off the same one. */
  cacheKey?: string;
}

interface CacheEntry {
  key: string;
  schema: Schema;
  /**
   * Values read for this exact version of this file, column by column, with
   * null remembering "asked, and there is no useful answer". They live on the
   * schema's own entry so that a rewritten file drops both at once.
   */
  values?: Map<string, ValueSet | null>;
}

/**
 * Dtypes whose values are worth completing. A value site is always inside a
 * string literal, so a number inserted there would be the wrong Python literal —
 * and low-cardinality string columns are the ones this is for anyway.
 */
const STRING_DTYPES = new Set(['str', 'cat', 'enum']);

/**
 * Reads schemas, remembers them, and never reads the same unchanged file twice.
 * The cache key includes the file's version (mtime+size locally, ETag remotely),
 * so a rewritten file invalidates itself even without a watcher.
 */
export class SchemaService {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<SchemaResult>>();
  private inFlightValues = new Map<string, Promise<ValueSet | null>>();
  /** sourceKey -> last successful result, so the completion path can answer instantly. */
  private lastKnown = new Map<string, SchemaResult>();

  constructor(private options: SchemaServiceOptions) {}

  updateOptions(options: SchemaServiceOptions): void {
    this.options = options;
  }

  /** A previously read schema for this source, if we have one. Synchronous. */
  peek(source: SourceRef, ctx: PathContext): SchemaResult | undefined {
    return this.lastKnown.get(sourceKey(source, ctx));
  }

  /**
   * Wait up to `budgetMs` for a schema. Past the budget the caller returns an
   * incomplete list and VS Code asks again a keystroke later, by which time the
   * read has landed — a slow disk never blocks typing.
   */
  async getWithBudget(
    source: SourceRef,
    ctx: PathContext,
    budgetMs: number
  ): Promise<SchemaResult | null> {
    const promise = this.get(source, ctx);
    if (budgetMs <= 0) return promise;
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs));
    return Promise.race([promise, timeout]);
  }

  async get(source: SourceRef, ctx: PathContext): Promise<SchemaResult> {
    const key = sourceKey(source, ctx);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const work = this.read(source, ctx)
      .catch((): SchemaResult => ({ error: 'read-failed' }))
      .then((result) => {
        this.inFlight.delete(key);
        if (result.schema) this.lastKnown.set(key, result);
        return result;
      });
    this.inFlight.set(key, work);
    return work;
  }

  private async read(source: SourceRef, ctx: PathContext): Promise<SchemaResult> {
    const resolved = await resolvePath(source, ctx);
    if (!resolved) return { error: 'file-not-found' };

    let storage: Storage;
    try {
      storage = storageFor(resolved.uri, { httpsEnabled: this.options.httpsEnabled });
    } catch (err) {
      if (err instanceof UnsupportedSchemeError) return { error: 'unsupported-scheme' };
      throw err;
    }

    const isTable = source.kind === 'delta' || source.kind === 'iceberg';
    const info = isTable ? null : await storage.stat(resolved.uri);
    if (!isTable && !info) return { error: 'file-not-found' };

    const version = info?.version ?? String(Math.floor(Date.now() / 30_000)); // tables: 30s TTL
    const cacheKey = `${source.kind}:${resolved.uri}:${version}:${JSON.stringify(source.kwargs)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.touch(cacheKey, cached);
      return { schema: cached.schema, uri: resolved.uri, cacheKey };
    }

    let columns: Column[];
    let rowCount: number | undefined;
    switch (source.kind) {
      case 'parquet': {
        const result = await readParquetSchema(storage, resolved.uri);
        columns = result.columns;
        rowCount = result.rowCount;
        break;
      }
      case 'csv':
        columns = await readCsvSchema(resolved.uri, source.kwargs, {
          sniffBytes: this.options.csvSniffBytes,
          inferDtypes: this.options.csvInferDtypes
        });
        break;
      case 'ipc':
        columns = await readIpcSchema(storage, resolved.uri);
        break;
      case 'delta':
        columns = await readDeltaSchema(storage, resolved.uri);
        break;
      case 'iceberg':
        columns = await readIcebergSchema(storage, resolved.uri);
        break;
      case 'json':
        // Same prefix read as CSV, and the same setting bounds it — one knob for
        // "how much of a text file is worth reading to find its shape".
        columns = await readJsonSchema(resolved.uri, this.options.csvSniffBytes);
        break;
      case 'excel':
        columns = await readExcelSchema(storage, resolved.uri);
        break;
    }

    if (!columns.length) return { error: 'read-failed', uri: resolved.uri };

    const known = new Set(columns.map((c) => c.name));
    for (const partition of resolved.hivePartitions) {
      if (!known.has(partition.name)) columns.push(partition);
    }
    if (columns.length > this.options.maxColumns) {
      columns = columns.slice(0, this.options.maxColumns);
    }

    const schema: Schema = { columns, rowCount, origin: resolved.uri };
    this.touch(cacheKey, { key: cacheKey, schema });
    return { schema, uri: resolved.uri, cacheKey };
  }


  /**
   * The values a column holds — the only thing here that reads data rather than
   * metadata, and the reason `valuesEnabled` exists. Null means "no useful
   * answer": the setting is off, the column is not one whose values are typed
   * as strings, the format cannot be read, or there are simply too many.
   *
   * Answers are remembered on the schema's own cache entry, null included, so a
   * column with four million ids is asked about once rather than once per
   * keystroke — and a rewritten file drops the values with the schema.
   */
  async values(source: SourceRef, ctx: PathContext, column: string): Promise<ValueSet | null> {
    if (!this.options.valuesEnabled) return null;

    const result = await this.get(source, ctx);
    if (!result.schema || !result.cacheKey) return null;
    const entry = this.cache.get(result.cacheKey);
    if (!entry) return null;

    const known = entry.values?.get(column);
    if (known !== undefined) return known;

    // Typing inside the string re-asks on every keystroke. Without this, each
    // one starts its own read of the same column — which for the one feature
    // that reads data is the last place to be doing the work more than once.
    const key = `${result.cacheKey}#${column}`;
    const running = this.inFlightValues.get(key);
    if (running) return running;

    const dtype = result.schema.columns.find((c) => c.name === column)?.dtype;
    const work = (dtype !== undefined && STRING_DTYPES.has(dtype)
      ? this.readValues(source, ctx, column)
      : Promise.resolve(null)
    )
      .catch((): ValueSet | null => null)
      .then((found) => {
        this.inFlightValues.delete(key);
        if (!entry.values) entry.values = new Map();
        entry.values.set(column, found);
        return found;
      });
    this.inFlightValues.set(key, work);
    return work;
  }

  private async readValues(
    source: SourceRef, ctx: PathContext, column: string
  ): Promise<ValueSet | null> {
    const resolved = await resolvePath(source, ctx);
    if (!resolved) return null;
    const options = {
      maxRows: this.options.valueMaxRows,
      maxDistinct: this.options.valueMaxDistinct
    };

    // A partition column's values are the directory names. No data is read, and
    // the answer is the whole domain rather than a sample of it.
    if (resolved.hiveRoot && resolved.hivePartitions.some((c) => c.name === column)) {
      const values = await hiveValues(resolved.hiveRoot, column, options.maxDistinct);
      return values ? { values, complete: true } : null;
    }

    // Parquet only. Reading values out of a Delta or Iceberg table means finding
    // its data files first, and out of Arrow IPC means decoding its buffers —
    // both are more than a column read, and neither is this feature.
    if (source.kind !== 'parquet') return null;

    let storage: Storage;
    try {
      storage = storageFor(resolved.uri, { httpsEnabled: this.options.httpsEnabled });
    } catch {
      return null;
    }
    return readParquetValues(storage, resolved.uri, column, options);
  }

  private touch(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.options.cacheSize) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  /** Drop everything we know about a file that changed on disk. */
  invalidate(uri: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.includes(uri)) this.cache.delete(key);
    }
    for (const [key, value] of [...this.lastKnown.entries()]) {
      if (value.uri && (value.uri === uri || uri.startsWith(value.uri))) this.lastKnown.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
    this.lastKnown.clear();
    this.inFlightValues.clear();
  }
}

function sourceKey(source: SourceRef, ctx: PathContext): string {
  return `${source.kind}|${source.path}|${ctx.documentDir}|${JSON.stringify(source.kwargs)}`;
}
