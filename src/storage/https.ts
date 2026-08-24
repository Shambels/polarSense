import { asyncBufferFromUrl } from 'hyparquet';
import type { AsyncBuffer } from 'hyparquet';
import type { DirEntry, StatInfo, Storage } from './index.js';

/**
 * Public HTTP(S) files, read with range requests. Off unless the user opts in,
 * because a completion provider should never make network calls unasked.
 * There is no directory listing over plain HTTP, so Delta and Iceberg tables
 * are local-only for now.
 */
export const httpsStorage: Storage = {
  async stat(uri: string): Promise<StatInfo | null> {
    try {
      const res = await fetch(uri, { method: 'HEAD' });
      if (!res.ok) return null;
      const size = Number(res.headers.get('content-length') ?? '0');
      const version = res.headers.get('etag') ?? res.headers.get('last-modified') ?? String(size);
      return { size, version };
    } catch {
      return null;
    }
  },

  async readAll(uri: string): Promise<Uint8Array> {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${uri}`);
    return new Uint8Array(await res.arrayBuffer());
  },

  async list(): Promise<DirEntry[]> {
    return [];
  },

  async asyncBuffer(uri: string): Promise<AsyncBuffer> {
    return asyncBufferFromUrl({ url: uri });
  }
};

export async function readHeadHttps(uri: string, limit: number): Promise<Uint8Array> {
  const res = await fetch(uri, { headers: { Range: `bytes=0-${limit - 1}` } });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} for ${uri}`);
  return new Uint8Array(await res.arrayBuffer());
}
