import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  initParser, parse, buildBindingTable, resolveAtOffset, readParquetSchema, localStorage
} from '../harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'test', 'fixtures', 'data');

/**
 * A completion that takes 200ms feels broken even when it is correct, so the
 * budget is asserted rather than hoped for. These numbers are generous compared
 * to the plan's targets so the guard fails on regressions, not on a busy CI box.
 */

test('warm resolution on a 1000-statement file stays under 10ms', async () => {
  const source = readFileSync(path.join(DATA, 'big_script.py'), 'utf8');
  const offset = source.lastIndexOf('""') + 1;
  const parser = await initParser(ROOT);

  const tree = parse(parser, source);
  const table = buildBindingTable(tree);

  // Warm-up, then measure the steady state: this is what runs per keystroke.
  for (let i = 0; i < 5; i++) resolveAtOffset(tree, table, offset);

  const started = performance.now();
  const runs = 200;
  for (let i = 0; i < runs; i++) {
    const res = resolveAtOffset(tree, table, offset);
    assert.equal(res.source?.path, 'wide.parquet');
  }
  const perCall = (performance.now() - started) / runs;
  assert.ok(perCall < 10, `resolution took ${perCall.toFixed(2)}ms per call`);
});

test('parsing a 1000-statement file stays under 250ms', async () => {
  const source = readFileSync(path.join(DATA, 'big_script.py'), 'utf8');
  const parser = await initParser(ROOT);
  const started = performance.now();
  const tree = parse(parser, source);
  buildBindingTable(tree);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 250, `cold parse + bindings took ${elapsed.toFixed(0)}ms`);
});

test('a 5000-column parquet footer reads in under 250ms', async () => {
  const started = performance.now();
  const columns = await readParquetSchema(localStorage, path.join(DATA, 'wide.parquet'));
  const elapsed = performance.now() - started;
  assert.equal(columns.length, 5000);
  assert.ok(elapsed < 250, `footer read took ${elapsed.toFixed(0)}ms`);
});
