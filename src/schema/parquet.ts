import { parquetMetadataAsync, parquetSchema } from 'hyparquet';
import type { Column } from '../core/types.js';
import type { Storage } from '../storage/index.js';
import { parquetDtype, type ParquetNode } from './dtypes.js';

/**
 * Two range reads and no decompression: the trailing bytes that hold the footer
 * length, then the footer itself. Cost is independent of how big the file is.
 */
export async function readParquetSchema(storage: Storage, uri: string): Promise<Column[]> {
  const buffer = await storage.asyncBuffer(uri);
  const metadata = await parquetMetadataAsync(buffer);
  const schema = parquetSchema(metadata) as unknown as ParquetNode;
  return schema.children.map((child) => ({
    name: child.element.name,
    dtype: parquetDtype(child)
  }));
}

export async function readIpcSchema(storage: Storage, uri: string): Promise<Column[]> {
  // Arrow IPC carries its schema in a flatbuffer at the head of the file. Rather
  // than pull in a full Arrow implementation for the one format nobody asked
  // about, report nothing and let the caller fall through cleanly.
  void storage;
  void uri;
  return [];
}
