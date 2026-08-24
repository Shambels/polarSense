import type { Column, Schema, SourceRef } from '../core/types.js';
import { storageFor, UnsupportedSchemeError, type Storage } from '../storage/index.js';
import { resolvePath, type PathContext } from '../paths.js';
import { readParquetSchema, readIpcSchema } from './parquet.js';
import { readCsvSchema } from './csv.js';
import { readDeltaSchema } from './delta.js';
import { readIcebergSchema } from './iceberg.js';

export interface SchemaServiceOptions {
  cacheSize: number;
  maxColumns: number;
  httpsEnabled: boolean;
  csvSniffBytes: number;
  csvInferDtypes: boolean;
}

export interface SchemaResult {
  schema?: Schema;
  /** The concrete file we read, for the status bar and cache invalidation. */
  uri?: string;
  error?: 'file-not-found' | 'unsupported-scheme' | 'read-failed';
}

interface CacheEntry {
  key: string;
  schema: Schema;
}

/**
 * Reads schemas, remembers them, and never reads the same unchanged file twice.
 * The cache key includes the file's version (mtime+size locally, ETag remotely),
 * so a rewritten file invalidates itself even without a watcher.
 */
export class SchemaService {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<SchemaResult>>();
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
      return { schema: cached.schema, uri: resolved.uri };
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
    return { schema, uri: resolved.uri };
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
  }
}

function sourceKey(source: SourceRef, ctx: PathContext): string {
  return `${source.kind}|${source.path}|${ctx.documentDir}|${JSON.stringify(source.kwargs)}`;
}
