/** Bundled entry point for the unit tests: everything that does not touch vscode. */
export { initParser, parse, repairAtCursor } from '../src/core/parser.js';
export { buildBindingTable, readImports, SOURCE_FUNCS } from '../src/core/bindings.js';
export { ModuleGraph, moduleCandidates } from '../src/core/modules.js';
export { resolveAtOffset } from '../src/core/resolve.js';
export { constEval, collectConstants } from '../src/core/constEval.js';
export { readParquetSchema } from '../src/schema/parquet.js';
export { readCsvSchema } from '../src/schema/csv.js';
export { readIpcSchema } from '../src/schema/ipc.js';
export {
  readDeltaSchema, checkpointFiles, parseDeltaSchemaString
} from '../src/schema/delta.js';
export { readIcebergSchema, parseIcebergMetadata } from '../src/schema/iceberg.js';
export { readJsonSchema } from '../src/schema/json.js';
export { readExcelSchema } from '../src/schema/excel.js';
export { readParquetValues } from '../src/schema/values.js';
export { readParquetRows, readCsvRows } from '../src/schema/rows.js';
export { readParquetSeries, readCsvSeries } from '../src/schema/series.js';
export { buildChart, kindsFor, familyOf, defaultAxis, truncate } from '../src/schema/chart.js';
export { chartFetchSnippet, parseChartJson, MARKER } from '../src/schema/kernelSeries.js';
export { formatValue } from '../src/schema/format.js';
export { SchemaService } from '../src/schema/index.js';
export { localStorage } from '../src/storage/local.js';
export {
  resolvePath, hiveColumns, hiveValues, completeDataPaths, kindForFile
} from '../src/paths.js';
export { EXPR_FUNCS, FRAME_METHODS, FRAGMENT_METHODS } from '../src/core/triggerSites.js';
export {
  dataPathInSql, sqlSource, sqlTables, sqlColumnPosition, SQL_FUNCS
} from '../src/core/sql.js';
export { collectPragmas } from '../src/core/pragma.js';
export { SELECTOR_FUNCS, PARTIAL_SELECTORS } from '../src/core/selectors.js';
export { resolveFrame, framesSources } from '../src/core/frame.js';
export { evaluateFrame, structFields } from '../src/core/schemaEval.js';
export { exprNames } from '../src/core/exprNames.js';
export { nearest } from '../src/core/nearest.js';
export { looksLikeFrame, lastStatementOffset } from '../src/preview/cells.js';
export { dtypeClass, sortNote } from '../src/preview/facts.js';

import { initParser } from '../src/core/parser.js';
import { parse, repairAtCursor } from '../src/core/parser.js';
import { buildBindingTable } from '../src/core/bindings.js';
import { resolveAtOffset } from '../src/core/resolve.js';
import type { Resolution } from '../src/core/types.js';
import * as path from 'node:path';
import type { Tree } from 'web-tree-sitter';
import { ModuleGraph } from '../src/core/modules.js';

/** Where a multi-file test project pretends to live. */
const PROJECT = path.resolve(path.sep, 'polarsense-test');

/**
 * Analyse one file of a project given as `{ "loaders.py": source }`, with the
 * others resolvable as modules — the multi-file shape of `resolveMarked`.
 */
export async function analyzeProject(
  files: Record<string, string>, entry: string, assetDir: string
) {
  const parser = await initParser(assetDir);
  const parsed = new Map<string, { path: string; tree: Tree }>();
  for (const [name, source] of Object.entries(files)) {
    const full = path.join(PROJECT, name);
    parsed.set(full, { path: full, tree: parse(parser, source) });
  }
  const entryPath = path.join(PROJECT, entry);
  const tree = parsed.get(entryPath)?.tree;
  if (!tree) throw new Error(`project has no entry file ${entry}`);
  const graph = new ModuleGraph(parsed, [PROJECT]);
  return { tree, table: buildBindingTable(tree, graph.loaderFor(path.dirname(entryPath))) };
}

/** As above, with `|` in the entry file marking the cursor. */
export async function resolveProject(
  files: Record<string, string>, entry: string, assetDir: string
): Promise<Resolution> {
  const marked = files[entry];
  const offset = marked.indexOf('|');
  if (offset === -1) throw new Error('project entry has no | cursor marker');
  const source = marked.slice(0, offset) + marked.slice(offset + 1);
  const { tree, table } = await analyzeProject({ ...files, [entry]: source }, entry, assetDir);
  return resolveAtOffset(tree, table, offset);
}

/**
 * Resolve a snippet with `|` marking the cursor — the shape the whole corpus is
 * written in, so a test case reads like the code a user would be typing.
 */
export async function resolveMarked(marked: string, assetDir: string): Promise<Resolution> {
  const offset = marked.indexOf('|');
  if (offset === -1) throw new Error('corpus snippet has no | cursor marker');
  const source = marked.slice(0, offset) + marked.slice(offset + 1);
  const parser = await initParser(assetDir);
  const repaired = repairAtCursor(source, offset);
  const tree = parse(parser, repaired);
  return resolveAtOffset(tree, buildBindingTable(tree), offset);
}

/** Parse a snippet and return its tree and binding table, for tests that need the table. */
export async function analyzeSource(source: string, assetDir: string) {
  const parser = await initParser(assetDir);
  const tree = parse(parser, source);
  return { tree, table: buildBindingTable(tree) };
}
