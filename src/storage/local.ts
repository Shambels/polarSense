import * as fs from 'node:fs/promises';
import { asyncBufferFromFile } from 'hyparquet';
import type { AsyncBuffer } from 'hyparquet';
import type { DirEntry, StatInfo, Storage } from './index.js';

function toPath(uri: string): string {
  if (uri.startsWith('file://')) return decodeURIComponent(new URL(uri).pathname);
  return uri;
}

export const localStorage: Storage = {
  async stat(uri: string): Promise<StatInfo | null> {
    try {
      const info = await fs.stat(toPath(uri));
      return { size: info.size, version: `${info.mtimeMs}:${info.size}` };
    } catch {
      return null;
    }
  },

  async readAll(uri: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(toPath(uri)));
  },

  async list(dirUri: string): Promise<DirEntry[]> {
    try {
      const entries = await fs.readdir(toPath(dirUri), { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return [];
    }
  },

  async asyncBuffer(uri: string): Promise<AsyncBuffer> {
    return asyncBufferFromFile(toPath(uri));
  }
};

/** Read only the first `limit` bytes — used by the CSV header sniffer. */
export async function readHead(uri: string, limit: number): Promise<Uint8Array> {
  const handle = await fs.open(toPath(uri), 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return new Uint8Array(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
