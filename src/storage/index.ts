import type { AsyncBuffer } from 'hyparquet';
import { localStorage } from './local.js';
import { httpsStorage } from './https.js';

export interface StatInfo {
  size: number;
  /** Local files use mtime; remote objects use an ETag. Either way it keys the cache. */
  version: string;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

/**
 * Everything the schema readers need from a location. Keeping the readers on this
 * interface rather than on `fs` is what leaves room for s3:// and gs:// later —
 * a parquet footer read is just a byte range, wherever the bytes live.
 */
export interface Storage {
  stat(uri: string): Promise<StatInfo | null>;
  readAll(uri: string): Promise<Uint8Array>;
  list(dirUri: string): Promise<DirEntry[]>;
  asyncBuffer(uri: string): Promise<AsyncBuffer>;
}

export class UnsupportedSchemeError extends Error {
  constructor(public readonly scheme: string) {
    super(`PolarSense cannot read schemas from ${scheme}:// locations yet.`);
  }
}

export interface StorageOptions {
  httpsEnabled: boolean;
}

export function storageFor(uri: string, options: StorageOptions): Storage {
  const scheme = schemeOf(uri);
  switch (scheme) {
    case 'file':
      return localStorage;
    case 'https':
    case 'http':
      if (!options.httpsEnabled) throw new UnsupportedSchemeError(scheme);
      return httpsStorage;
    default:
      throw new UnsupportedSchemeError(scheme);
  }
}

export function schemeOf(uri: string): string {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(uri);
  return match ? match[1].toLowerCase() : 'file';
}

/** Join a location and a child segment, for both filesystem paths and URLs. */
export function joinUri(base: string, child: string): string {
  return base.endsWith('/') ? base + child : `${base}/${child}`;
}
