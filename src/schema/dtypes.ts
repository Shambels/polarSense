/**
 * Native file types → the names polars prints in `df.schema`. These are our
 * translation, not polars' own, so edge cases (nested lists of structs,
 * timezone-aware timestamps) can read slightly differently. Kept in one file so
 * the day polars renames a dtype there is exactly one place to fix.
 */

export interface ParquetElement {
  type?: string;
  converted_type?: string;
  logical_type?: { type: string; [key: string]: unknown };
  num_children?: number;
  scale?: number;
  precision?: number;
  type_length?: number;
}

export interface ParquetNode {
  element: ParquetElement & { name: string };
  children: ParquetNode[];
}

export function parquetDtype(node: ParquetNode): string {
  const el = node.element;
  const logical = el.logical_type;
  const converted = el.converted_type;

  if (logical?.type === 'LIST' || converted === 'LIST') {
    const inner = listElement(node);
    return `list[${inner ? parquetDtype(inner) : 'null'}]`;
  }
  if (logical?.type === 'MAP' || converted === 'MAP') {
    const kv = node.children[0];
    const key = kv?.children[0];
    const value = kv?.children[1];
    return `struct[${key ? parquetDtype(key) : 'null'}, ${value ? parquetDtype(value) : 'null'}]`;
  }
  if (node.children.length > 0 || (el.num_children ?? 0) > 0) {
    return `struct[${node.children.length}]`;
  }
  if (logical?.type === 'STRING' || converted === 'UTF8') return 'str';
  if (logical?.type === 'ENUM' || converted === 'ENUM') return 'cat';
  if (logical?.type === 'UUID') return 'str';
  if (logical?.type === 'JSON' || converted === 'JSON') return 'str';
  if (logical?.type === 'DATE' || converted === 'DATE') return 'date';

  if (logical?.type === 'TIMESTAMP') {
    const unit = timeUnit(String(logical.unit ?? 'MICROS'));
    return logical.isAdjustedToUTC ? `datetime[${unit}, UTC]` : `datetime[${unit}]`;
  }
  if (converted === 'TIMESTAMP_MILLIS') return 'datetime[ms]';
  if (converted === 'TIMESTAMP_MICROS') return 'datetime[μs]';
  if (logical?.type === 'TIME') return `time`;
  if (converted === 'TIME_MILLIS' || converted === 'TIME_MICROS') return 'time';

  if (logical?.type === 'DECIMAL' || converted === 'DECIMAL') {
    const precision = el.precision ?? Number(logical?.precision ?? 0);
    const scale = el.scale ?? Number(logical?.scale ?? 0);
    return `decimal[${precision},${scale}]`;
  }

  if (logical?.type === 'INTEGER') {
    const bits = Number(logical.bitWidth ?? 64);
    const signed = logical.isSigned !== false;
    return `${signed ? 'i' : 'u'}${bits}`;
  }
  if (converted?.startsWith('UINT_')) return `u${converted.slice(5)}`;
  if (converted?.startsWith('INT_')) return `i${converted.slice(4)}`;

  switch (el.type) {
    case 'BOOLEAN': return 'bool';
    case 'INT32': return 'i32';
    case 'INT64': return 'i64';
    case 'INT96': return 'datetime[ns]';
    case 'FLOAT': return 'f32';
    case 'DOUBLE': return 'f64';
    case 'BYTE_ARRAY': return 'binary';
    case 'FIXED_LEN_BYTE_ARRAY': return 'binary';
    default: return '';
  }
}

function listElement(node: ParquetNode): ParquetNode | null {
  // LIST -> repeated group (list/bag) -> element
  const repeated = node.children[0];
  if (!repeated) return null;
  if (repeated.children.length === 1) return repeated.children[0];
  return repeated;
}

function timeUnit(unit: string): string {
  switch (unit.toUpperCase()) {
    case 'MILLIS': return 'ms';
    case 'NANOS': return 'ns';
    default: return 'μs';
  }
}

/** Delta Lake schema types (the `schemaString` JSON). */
export function deltaDtype(type: unknown): string {
  if (typeof type === 'string') {
    const decimal = /^decimal\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(type);
    if (decimal) return `decimal[${decimal[1]},${decimal[2]}]`;
    switch (type) {
      case 'string': return 'str';
      case 'long': return 'i64';
      case 'integer': return 'i32';
      case 'short': return 'i16';
      case 'byte': return 'i8';
      case 'float': return 'f32';
      case 'double': return 'f64';
      case 'boolean': return 'bool';
      case 'binary': return 'binary';
      case 'date': return 'date';
      case 'timestamp': return 'datetime[μs, UTC]';
      case 'timestamp_ntz': return 'datetime[μs]';
      default: return type;
    }
  }
  if (type && typeof type === 'object') {
    const t = type as Record<string, unknown>;
    if (t.type === 'array') return `list[${deltaDtype(t.elementType)}]`;
    if (t.type === 'map') return `struct[${deltaDtype(t.keyType)}, ${deltaDtype(t.valueType)}]`;
    if (t.type === 'struct') {
      const fields = Array.isArray(t.fields) ? t.fields.length : 0;
      return `struct[${fields}]`;
    }
  }
  return '';
}

/** Iceberg schema types (the `metadata.json` schema entry). */
export function icebergDtype(type: unknown): string {
  if (typeof type === 'string') {
    const decimal = /^decimal\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(type);
    if (decimal) return `decimal[${decimal[1]},${decimal[2]}]`;
    if (/^fixed\[/.test(type)) return 'binary';
    switch (type) {
      case 'string': return 'str';
      case 'long': return 'i64';
      case 'int': return 'i32';
      case 'float': return 'f32';
      case 'double': return 'f64';
      case 'boolean': return 'bool';
      case 'binary': return 'binary';
      case 'uuid': return 'str';
      case 'date': return 'date';
      case 'time': return 'time';
      case 'timestamp': return 'datetime[μs]';
      case 'timestamptz': return 'datetime[μs, UTC]';
      case 'timestamp_ns': return 'datetime[ns]';
      case 'timestamptz_ns': return 'datetime[ns, UTC]';
      default: return type;
    }
  }
  if (type && typeof type === 'object') {
    const t = type as Record<string, unknown>;
    if (t.type === 'list') return `list[${icebergDtype(t.element)}]`;
    if (t.type === 'map') return `struct[${icebergDtype(t.key)}, ${icebergDtype(t.value)}]`;
    if (t.type === 'struct') {
      const fields = Array.isArray(t.fields) ? t.fields.length : 0;
      return `struct[${fields}]`;
    }
  }
  return '';
}
