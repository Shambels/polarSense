import type { Column } from '../core/types.js';
import { joinUri, type Storage } from '../storage/index.js';
import { icebergDtype } from './dtypes.js';

const METADATA = /^v?(\d+)[-.].*\.metadata\.json$|^(\d+)\.metadata\.json$/;

/**
 * `metadata/version-hint.text` names the current metadata file; without one, take
 * the highest version present. Then `current-schema-id` picks the live schema out
 * of `schemas[]`. Filesystem tables only — REST, Glue and Nessie catalogs need a
 * network client and a credential story of their own.
 */
export async function readIcebergSchema(storage: Storage, tableUri: string): Promise<Column[]> {
  const metaUri = joinUri(tableUri, 'metadata');
  const entries = await storage.list(metaUri);
  if (!entries.length) return [];

  let target: string | null = null;
  if (entries.some((e) => e.name === 'version-hint.text')) {
    const bytes = await storage.readAll(joinUri(metaUri, 'version-hint.text')).catch(() => null);
    const hint = bytes ? new TextDecoder('utf-8').decode(bytes).trim() : '';
    if (/^\d+$/.test(hint)) {
      const match = entries.find((e) => e.name === `v${hint}.metadata.json`) ??
        entries.find((e) => e.name.startsWith(`${hint}-`) && e.name.endsWith('.metadata.json'));
      target = match?.name ?? null;
    }
  }
  if (!target) {
    const versioned = entries
      .filter((e) => !e.isDir && e.name.endsWith('.metadata.json'))
      .map((e) => ({ name: e.name, version: versionOf(e.name) }))
      .filter((e) => e.version !== null)
      .sort((a, b) => (a.version! - b.version!));
    target = versioned.length ? versioned[versioned.length - 1].name : null;
  }
  if (!target) return [];

  const bytes = await storage.readAll(joinUri(metaUri, target)).catch(() => null);
  if (!bytes) return [];
  return parseIcebergMetadata(new TextDecoder('utf-8').decode(bytes));
}

export function parseIcebergMetadata(json: string): Column[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return [];
  }
  const schemas = parsed['schemas'];
  const currentId = parsed['current-schema-id'];
  let schema: Record<string, unknown> | undefined;
  if (Array.isArray(schemas)) {
    schema = (schemas as Record<string, unknown>[])
      .find((s) => s['schema-id'] === currentId) ?? (schemas as Record<string, unknown>[]).at(-1);
  }
  // format-version 1 tables keep the schema at the top level.
  if (!schema && parsed['schema']) schema = parsed['schema'] as Record<string, unknown>;
  const fields = schema?.['fields'];
  if (!Array.isArray(fields)) return [];
  return fields.map((field) => {
    const f = field as Record<string, unknown>;
    return { name: String(f['name'] ?? ''), dtype: icebergDtype(f['type']) };
  }).filter((c) => c.name !== '');
}

function versionOf(name: string): number | null {
  const match = METADATA.exec(name);
  if (!match) return null;
  const digits = match[1] ?? match[2];
  return digits ? Number(digits) : null;
}
