import type { Column } from '../core/types.js';
import type { AsyncBuffer } from 'hyparquet';
import type { Storage } from '../storage/index.js';
import { arrowDtype, ArrowTypeId, type ArrowTypeInfo } from './dtypes.js';

/**
 * Arrow IPC — `.arrow`, `.ipc` and Feather V2 — plus the stream form the same
 * writers produce.
 *
 * The two shapes keep their schema in different places, and each is read where
 * its own spec puts it. A file ends with a footer indexing the whole thing, the
 * way a parquet file does, so the schema is read from there: the head of a file
 * is not dependable — polars writes its first message with no length prefix at
 * all, which a reader scanning forward would walk straight off. A stream has no
 * footer, so there its schema is the first message, which is where it must be.
 * Either way it is two range reads and no decompression, whatever the file
 * weighs — the same bargain as the parquet reader.
 *
 * The metadata is a flatbuffer. Lifting a list of field names out of one is a
 * vtable walk of about eighty lines, so it is hand-rolled here rather than
 * pulling in an Arrow implementation whose actual job is decoding the buffers
 * underneath — the part this extension deliberately never reads.
 */

/** "ARROW1", then two padding bytes, before the first message of a file. */
const MAGIC = [0x41, 0x52, 0x52, 0x4f, 0x57, 0x31];
/** "FEA1" — Feather V1, a different format that happens to share an extension. */
const FEATHER_V1 = [0x46, 0x45, 0x41, 0x31];
/** Written ahead of every message length since Arrow 0.15, absent before it. */
const CONTINUATION = 0xffffffff;
/** Enough for the magic, a continuation marker and a length. */
const PREFIX_BYTES = 16;
/** A file closes with its footer's length and the magic again. */
const FOOTER_TAIL = 4 + MAGIC.length;
/** Past this a "length" is a misread file, not a wide table. */
const MAX_METADATA = 64 * 1024 * 1024;

export async function readIpcSchema(storage: Storage, uri: string): Promise<Column[]> {
  const buffer = await storage.asyncBuffer(uri);
  if (buffer.byteLength < PREFIX_BYTES) return [];
  const prefix = new DataView(await buffer.slice(0, PREFIX_BYTES));
  if (startsWith(prefix, FEATHER_V1)) return [];

  try {
    return startsWith(prefix, MAGIC)
      ? await fromFooter(buffer)
      : await fromFirstMessage(buffer, prefix);
  } catch {
    // Every offset in a flatbuffer is read out of the bytes before it, so a
    // truncated or non-Arrow file walks off the end of itself. Reporting nothing
    // is the honest answer: half a schema hides real columns.
    return [];
  }
}

/** The file format: `<footer length><ARROW1>` at the very end points at the rest. */
async function fromFooter(buffer: AsyncBuffer): Promise<Column[]> {
  const tail = new DataView(
    await buffer.slice(buffer.byteLength - FOOTER_TAIL, buffer.byteLength)
  );
  const length = tail.getInt32(0, true);
  if (length <= 0 || length > MAX_METADATA || length + FOOTER_TAIL > buffer.byteLength) return [];

  const at = buffer.byteLength - FOOTER_TAIL - length;
  const footer = new DataView(await buffer.slice(at, at + length));
  const schema = slot(footer, deref(footer, 0), FOOTER_SCHEMA);
  return schema ? columnsOf(footer, deref(footer, schema)) : [];
}

/** The stream format: no magic and no footer, so the schema is message one. */
async function fromFirstMessage(buffer: AsyncBuffer, prefix: DataView): Promise<Column[]> {
  let at = prefix.getUint32(0, true) === CONTINUATION ? 4 : 0;
  const length = prefix.getUint32(at, true);
  at += 4;
  if (length === 0 || length > MAX_METADATA || at + length > buffer.byteLength) return [];

  const message = new DataView(await buffer.slice(at, at + length));
  const table = deref(message, 0);
  // A stream can open with a dictionary batch instead; only a schema is ours.
  if (byte(message, table, MESSAGE_HEADER_TYPE) !== HEADER_IS_SCHEMA) return [];
  const header = slot(message, table, MESSAGE_HEADER);
  return header ? columnsOf(message, deref(message, header)) : [];
}

/** Field ids, as `Message.fbs` and `Schema.fbs` declare them. */
const MESSAGE_HEADER_TYPE = 1;
const MESSAGE_HEADER = 2;
const HEADER_IS_SCHEMA = 1;
const FOOTER_SCHEMA = 1;
const SCHEMA_FIELDS = 1;
const FIELD_NAME = 0;
const FIELD_TYPE_TYPE = 2;
const FIELD_TYPE = 3;
const FIELD_DICTIONARY = 4;
const FIELD_CHILDREN = 5;

/** The columns of a `Schema` table, wherever it was found. */
function columnsOf(v: DataView, schema: number): Column[] {
  return elements(v, schema, SCHEMA_FIELDS)
    .map((pos) => readField(v, deref(v, pos)))
    .filter((column) => column.name !== '');
}

function readField(v: DataView, field: number): Column {
  const id = byte(v, field, FIELD_TYPE_TYPE);
  const type = slot(v, field, FIELD_TYPE);
  const children = elements(v, field, FIELD_CHILDREN).map((pos) => readField(v, deref(v, pos)));

  const info: ArrowTypeInfo = {
    id,
    dictionary: slot(v, field, FIELD_DICTIONARY) !== 0,
    children: childDtypes(id, children),
    ...(type ? typeArgs(v, id, deref(v, type)) : {})
  };
  const column: Column = { name: text(v, field, FIELD_NAME) ?? '', dtype: arrowDtype(info) };
  // Only a struct's children are fields anyone would name. A list's child is its
  // element and a map's is its key/value pair — machinery, exactly as in parquet.
  if (id === ArrowTypeId.Struct && children.length) column.fields = children;
  return column;
}

/**
 * The child dtypes a name needs. A map's arrive one level down — its only child
 * is the `entries` struct — so they are lifted here, which is what makes a map
 * read the same as one out of a parquet file.
 */
function childDtypes(id: number, children: Column[]): string[] {
  if (id === ArrowTypeId.Map) return (children[0]?.fields ?? []).map((c) => c.dtype);
  return children.map((c) => c.dtype);
}

/** The handful of type tables that carry a parameter the dtype name needs. */
function typeArgs(v: DataView, id: number, type: number): Partial<ArrowTypeInfo> {
  switch (id) {
    case ArrowTypeId.Int:
      return { bitWidth: int32(v, type, 0), signed: byte(v, type, 1) !== 0 };
    case ArrowTypeId.Float:
      return { precision: int16(v, type, 0) };
    case ArrowTypeId.Decimal:
      return { precision: int32(v, type, 0), scale: int32(v, type, 1) };
    // Date and Time default to MILLISECOND when the field is omitted, Timestamp
    // and Duration to SECOND and MILLISECOND. Defaults are not written out, so
    // reading a missing field as zero would silently change the unit.
    case ArrowTypeId.Date:
    case ArrowTypeId.Time:
    case ArrowTypeId.Duration:
      return { unit: int16(v, type, 0, 1) };
    case ArrowTypeId.Timestamp:
      return { unit: int16(v, type, 0), timezone: text(v, type, 1) };
    case ArrowTypeId.FixedSizeList:
      return { listSize: int32(v, type, 0) };
    default:
      return {};
  }
}

/* The flatbuffer walk. Everything is little-endian and every offset is relative
 * to the field that holds it, which is what keeps a buffer relocatable. */

/** The table or vector a uoffset at `pos` points at. */
function deref(v: DataView, pos: number): number {
  return pos + v.getUint32(pos, true);
}

/**
 * Where a table's field sits, or 0 when the table left it out and the reader
 * should use the default. A table stores a signed offset back to a vtable that
 * lists, per field, how far into the table its value is.
 */
function slot(v: DataView, table: number, id: number): number {
  const vtable = table - v.getInt32(table, true);
  const offset = 4 + id * 2;
  if (offset >= v.getUint16(vtable, true)) return 0;
  const relative = v.getUint16(vtable + offset, true);
  return relative ? table + relative : 0;
}

function byte(v: DataView, table: number, id: number): number {
  const at = slot(v, table, id);
  return at ? v.getUint8(at) : 0;
}

function int16(v: DataView, table: number, id: number, fallback = 0): number {
  const at = slot(v, table, id);
  return at ? v.getInt16(at, true) : fallback;
}

function int32(v: DataView, table: number, id: number, fallback = 0): number {
  const at = slot(v, table, id);
  return at ? v.getInt32(at, true) : fallback;
}

function text(v: DataView, table: number, id: number): string | undefined {
  const at = slot(v, table, id);
  if (!at) return undefined;
  const start = deref(v, at);
  const length = v.getUint32(start, true);
  return new TextDecoder('utf-8').decode(
    new Uint8Array(v.buffer, v.byteOffset + start + 4, length)
  );
}

/** The position of each slot in a vector, ready to be dereferenced. */
function elements(v: DataView, table: number, id: number): number[] {
  const at = slot(v, table, id);
  if (!at) return [];
  const start = deref(v, at);
  const count = v.getUint32(start, true);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(start + 4 + i * 4);
  return out;
}

function startsWith(v: DataView, bytes: number[]): boolean {
  return bytes.every((b, i) => v.getUint8(i) === b);
}
