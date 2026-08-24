/** Bundled entry point for the unit tests: everything that does not touch vscode. */
export { initParser, parse, repairAtCursor } from '../src/core/parser.js';
export { buildBindingTable } from '../src/core/bindings.js';
export { resolveAtOffset } from '../src/core/resolve.js';
export { constEval, collectConstants } from '../src/core/constEval.js';
export { readParquetSchema } from '../src/schema/parquet.js';
export { readCsvSchema } from '../src/schema/csv.js';
export { readDeltaSchema } from '../src/schema/delta.js';
export { readIcebergSchema } from '../src/schema/iceberg.js';
export { localStorage } from '../src/storage/local.js';
export { resolvePath, hiveColumns, completeDataPaths } from '../src/paths.js';
export { EXPR_FUNCS, FRAME_METHODS } from '../src/core/triggerSites.js';
export { resolveFrame, framesSources } from '../src/core/frame.js';
export { evaluateFrame } from '../src/core/schemaEval.js';
export { exprNames } from '../src/core/exprNames.js';
export { nearest } from '../src/core/nearest.js';

import { initParser } from '../src/core/parser.js';
import { parse, repairAtCursor } from '../src/core/parser.js';
import { buildBindingTable } from '../src/core/bindings.js';
import { resolveAtOffset } from '../src/core/resolve.js';
import type { Resolution } from '../src/core/types.js';

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
