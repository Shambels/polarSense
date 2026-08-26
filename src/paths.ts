import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Column, SourceRef } from './core/types.js';
import { schemeOf } from './storage/index.js';

export interface PathContext {
  /** Directory of the file being edited (or of the .ipynb, for notebooks). */
  documentDir: string;
  workspaceDirs: string[];
  extraRoots: string[];
}

export interface ResolvedPath {
  uri: string;
  /** Columns contributed by `key=value` directory segments, as polars adds them. */
  hivePartitions: Column[];
  /**
   * The directory the partitions were read out of, when there were any. The
   * resolved file names one value of each; the tree above it holds them all.
   */
  hiveRoot?: string;
}

const GLOB = /[*?[]/;

/**
 * Turn the path written at the call site into something a reader can open:
 * expand `~`, try each root in turn, resolve a glob or a directory down to a
 * concrete file, and pick up hive partition columns on the way.
 */
export async function resolvePath(
  source: SourceRef,
  ctx: PathContext
): Promise<ResolvedPath | null> {
  const raw = source.path;
  if (!raw) return null;

  const scheme = schemeOf(raw);
  if (scheme !== 'file') {
    // Remote locations are handed to the storage layer untouched.
    return { uri: raw, hivePartitions: [] };
  }

  const expanded = raw.startsWith('~')
    ? path.join(os.homedir(), raw.slice(1))
    : raw;

  const candidates = path.isAbsolute(expanded)
    ? [expanded]
    : [
        path.resolve(ctx.documentDir, expanded),
        ...ctx.workspaceDirs.map((dir) => path.resolve(dir, expanded)),
        ...ctx.extraRoots.map((dir) => path.resolve(dir, expanded))
      ];

  for (const candidate of candidates) {
    const resolved = await tryCandidate(candidate, source.kind);
    if (resolved) return resolved;
  }
  return null;
}

async function tryCandidate(candidate: string, kind: SourceRef['kind']): Promise<ResolvedPath | null> {
  if (GLOB.test(candidate)) {
    const match = await firstGlobMatch(candidate);
    if (!match) return null;
    const base = candidate.replace(/[*?[].*$/, '');
    return { uri: match, hivePartitions: hiveColumns(candidate, match), hiveRoot: base };
  }

  const info = await fs.stat(candidate).catch(() => null);
  if (!info) return null;

  if (info.isFile()) return { uri: candidate, hivePartitions: [] };

  if (info.isDirectory()) {
    // Delta and Iceberg tables *are* directories.
    if (kind === 'delta' || kind === 'iceberg') return { uri: candidate, hivePartitions: [] };
    const file = await firstFileUnder(candidate, extensionFor(kind));
    if (!file) return null;
    return { uri: file, hivePartitions: hiveColumns(candidate, file), hiveRoot: candidate };
  }
  return null;
}

export interface PathCandidate {
  /** Name of the entry, as it should be inserted. */
  name: string;
  isDir: boolean;
  /** True when this directory is itself a readable table. */
  isTable?: boolean;
}

const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', '.venv', 'venv', '.idea']);

/**
 * Entries that could continue the path being typed in a reader's first argument.
 * Directories are always offered — you have to walk through them to reach a file —
 * and files are filtered to the formats that reader can actually open.
 */
export async function completeDataPaths(
  prefix: string,
  kind: SourceRef['kind'],
  ctx: PathContext
): Promise<PathCandidate[]> {
  const slash = prefix.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : prefix.slice(0, slash);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(prefix)) return []; // remote: nothing to list

  const roots = path.isAbsolute(dirPart)
    ? [dirPart]
    : [
        path.resolve(ctx.documentDir, dirPart),
        ...ctx.workspaceDirs.map((dir) => path.resolve(dir, dirPart)),
        ...ctx.extraRoots.map((dir) => path.resolve(dir, dirPart))
      ];

  const wantsDirectory = kind === 'delta' || kind === 'iceberg';
  const extensions = extensionFor(kind);
  const seen = new Set<string>();
  const out: PathCandidate[] = [];

  for (const root of roots) {
    if (out.length >= 200) break;
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      if (seen.has(entry.name)) continue;

      if (entry.isDirectory()) {
        const isTable = await looksLikeTable(path.join(root, entry.name));
        // A parquet reader should not offer a Delta table directory, and vice versa.
        if (wantsDirectory && !isTable) {
          if (!(await hasInterestingDescendant(path.join(root, entry.name), kind))) continue;
        }
        seen.add(entry.name);
        out.push({ name: entry.name, isDir: true, isTable });
        continue;
      }
      if (wantsDirectory) continue;
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      seen.add(entry.name);
      out.push({ name: entry.name, isDir: false });
    }
  }
  return out;
}

async function looksLikeTable(dir: string): Promise<boolean> {
  const entries: string[] = await fs.readdir(dir).catch(() => []);
  return entries.includes('_delta_log') || entries.includes('metadata');
}

/** Cheap one-level look for a table further down, so parent folders stay offerable. */
async function hasInterestingDescendant(dir: string, kind: SourceRef['kind']): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (await looksLikeTable(path.join(dir, entry.name))) return true;
  }
  void kind;
  return false;
}

function extensionFor(kind: SourceRef['kind']): string[] {
  switch (kind) {
    case 'parquet': return ['.parquet', '.pq'];
    case 'csv': return ['.csv', '.tsv', '.txt'];
    case 'ipc': return ['.arrow', '.ipc', '.feather'];
    default: return [];
  }
}

/** First file matching a glob, walking segment by segment. Depth-limited. */
async function firstGlobMatch(pattern: string): Promise<string | null> {
  const segments = pattern.split(path.sep).filter((s) => s !== '');
  const absolute = pattern.startsWith(path.sep);
  let frontier: string[] = [absolute ? path.sep : ''];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;
    const next: string[] = [];

    for (const base of frontier) {
      if (next.length > 64) break;
      if (segment === '**') {
        next.push(base, ...(await subdirectories(base, 4)));
        continue;
      }
      if (!GLOB.test(segment)) {
        next.push(base === '' ? segment : path.join(base, segment));
        continue;
      }
      const entries = await fs.readdir(base || '.', { withFileTypes: true }).catch(() => []);
      const re = globToRegExp(segment);
      for (const entry of entries) {
        if (!re.test(entry.name)) continue;
        if (isLast && entry.isDirectory()) continue;
        next.push(path.join(base, entry.name));
      }
    }
    frontier = next;
    if (!frontier.length) return null;
  }

  for (const candidate of frontier.sort()) {
    const info = await fs.stat(candidate).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  return null;
}

async function subdirectories(base: string, depth: number): Promise<string[]> {
  if (depth <= 0) return [];
  const entries = await fs.readdir(base || '.', { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(base, entry.name);
    out.push(child, ...(await subdirectories(child, depth - 1)));
  }
  return out;
}

function globToRegExp(segment: string): RegExp {
  const source = segment
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`);
}

/** First file with one of `extensions` under `dir`, breadth-first. */
async function firstFileUnder(dir: string, extensions: string[], depth = 5): Promise<string | null> {
  if (depth <= 0) return null;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      return path.join(dir, entry.name);
    }
  }
  for (const entry of sorted) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const found = await firstFileUnder(path.join(dir, entry.name), extensions, depth - 1);
    if (found) return found;
  }
  return null;
}

/** `data/region=EU/part-0.parquet` contributes a `region` column, as polars does. */
export function hiveColumns(root: string, file: string): Column[] {
  const base = root.replace(/[*?[].*$/, '');
  const relative = file.startsWith(base) ? file.slice(base.length) : file;
  const columns: Column[] = [];
  const seen = new Set<string>();
  for (const segment of relative.split(path.sep)) {
    const match = /^([^=]+)=(.*)$/.exec(segment);
    if (!match) continue;
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    columns.push({ name, dtype: 'str' });
  }
  return columns;
}

/** polars' spelling of a null partition key, which is not a value anyone types. */
const HIVE_NULL = '__HIVE_DEFAULT_PARTITION__';

/**
 * Every value a hive partition column takes, read off the directory names.
 *
 * This is the one value lookup that costs nothing and cannot be a sample: the
 * partitioning *is* the list, so the answer is the whole domain of the column.
 * Null when there are more than `limit` of them — the same silence a
 * high-cardinality parquet column gets, for the same reason.
 */
export async function hiveValues(
  root: string, column: string, limit: number, depth = 5
): Promise<string[] | null> {
  const prefix = `${column}=`;
  const found = new Set<string>();

  const walk = async (dir: string, left: number): Promise<boolean> => {
    if (left <= 0) return true;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (entry.name.startsWith(prefix)) {
        const value = entry.name.slice(prefix.length);
        if (value && value !== HIVE_NULL) found.add(value);
        if (found.size > limit) return false;
        // Its own subdirectories partition on something else, not on this.
        continue;
      }
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      if (!(await walk(child, left - 1))) return false;
    }
    return true;
  };

  if (!(await walk(root, depth))) return null;
  if (!found.size) return null;
  return [...found].sort((a, b) => a.localeCompare(b));
}
