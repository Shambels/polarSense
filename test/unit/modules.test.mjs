import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveProject, analyzeProject, resolveMarked, readImports, moduleCandidates,
  initParser, parse, evaluateFrame
} from '../harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PL = 'import polars as pl\n';

/** `|` marks the cursor in main.py; the expected value is the path it resolves to. */
const CASES = [
  ['an imported frame', {
    'loaders.py': `${PL}sales = pl.scan_parquet("a.parquet")\n`,
    'main.py': 'from loaders import sales\nsales.select("|")'
  }, 'a.parquet'],

  ['an imported loader function', {
    'loaders.py': `${PL}def load_sales():\n    return pl.scan_parquet("a.parquet")\n`,
    'main.py': 'from loaders import load_sales\ndf = load_sales()\ndf.select("|")'
  }, 'a.parquet'],

  ['the call inline', {
    'loaders.py': `${PL}def load_sales():\n    return pl.scan_parquet("a.parquet")\n`,
    'main.py': 'from loaders import load_sales\nload_sales().select("|")'
  }, 'a.parquet'],

  ['an aliased import', {
    'loaders.py': `${PL}def load_sales():\n    return pl.scan_parquet("a.parquet")\n`,
    'main.py': 'from loaders import load_sales as load\nload().select("|")'
  }, 'a.parquet'],

  ['a module attribute', {
    'loaders.py': `${PL}sales = pl.scan_parquet("a.parquet")\n`,
    'main.py': 'import loaders\nloaders.sales.select("|")'
  }, 'a.parquet'],

  ['a module function', {
    'loaders.py': `${PL}def load():\n    return pl.scan_parquet("a.parquet")\n`,
    'main.py': 'import loaders\nloaders.load().select("|")'
  }, 'a.parquet'],

  ['an aliased module', {
    'loaders.py': `${PL}def load():\n    return pl.scan_parquet("a.parquet")\n`,
    'main.py': 'import loaders as ld\nld.load().select("|")'
  }, 'a.parquet'],

  ['a relative import', {
    'loaders.py': `${PL}sales = pl.scan_parquet("a.parquet")\n`,
    'main.py': 'from .loaders import sales\nsales.select("|")'
  }, 'a.parquet'],

  ['a package module', {
    'pkg/loaders.py': `${PL}sales = pl.scan_parquet("a.parquet")\n`,
    'main.py': 'from pkg.loaders import sales\nsales.select("|")'
  }, 'a.parquet'],

  ['a package __init__', {
    'pkg/__init__.py': `${PL}sales = pl.scan_parquet("a.parquet")\n`,
    'main.py': 'from pkg import sales\nsales.select("|")'
  }, 'a.parquet'],

  ['two hops', {
    'sources.py': `${PL}raw = pl.scan_parquet("a.parquet")\n`,
    'loaders.py': 'from sources import raw\nsales = raw.filter(x)\n',
    'main.py': 'from loaders import sales\nsales.select("|")'
  }, 'a.parquet'],

  ['a chain built in the other module', {
    'loaders.py': `${PL}def load():\n    return pl.scan_parquet("a.parquet").filter(x)\n`,
    'main.py': 'from loaders import load\nload().select("|")'
  }, 'a.parquet'],

  ['the module constant folds in its own file', {
    'loaders.py': `${PL}DATA = "data/a.parquet"\nsales = pl.scan_parquet(DATA)\n`,
    'main.py': 'from loaders import sales\nsales.select("|")'
  }, 'data/a.parquet'],

  ['a function with an early return', {
    'loaders.py': `${PL}def load(flag):\n    if flag:\n        return None\n    return pl.scan_parquet("a.parquet")\n`,
    'main.py': 'from loaders import load\nload().select("|")'
  }, 'a.parquet']
];

for (const [name, files, expected] of CASES) {
  test(`resolves across modules: ${name}`, async () => {
    const res = await resolveProject(files, 'main.py', ROOT);
    assert.equal(res.source?.path, expected, `failure was: ${res.failure ?? 'none'}`);
  });
}

/** A local `def` is the same machinery, and was invisible before it existed. */
test('a function in the same file returns a frame too', async () => {
  const res = await resolveMarked(
    `${PL}def load():\n    return pl.scan_parquet("a.parquet")\n\nload().select("|")`,
    ROOT
  );
  assert.equal(res.source?.path, 'a.parquet');
});

const NOTHING = [
  ['a module we cannot find', {
    'main.py': 'from nowhere import sales\nsales.select("|")'
  }],
  ['a name the module does not export', {
    'loaders.py': `${PL}sales = pl.scan_parquet("a.parquet")\n`,
    'main.py': 'from loaders import other\nother.select("|")'
  }],
  ['a function that returns something else', {
    'loaders.py': 'def config():\n    return {"source": "a.parquet"}\n',
    'main.py': 'from loaders import config\nconfig().select("|")'
  }],
  ['a method on a class, not a module function', {
    'loaders.py': `${PL}class Loader:\n    def load(self):\n        return pl.scan_parquet("a.parquet")\n`,
    'main.py': 'from loaders import Loader\nLoader().load().select("|")'
  }]
];

for (const [name, files] of NOTHING) {
  test(`stays quiet: ${name}`, async () => {
    const res = await resolveProject(files, 'main.py', ROOT);
    assert.equal(res.source?.path, undefined, 'should not have resolved to a path');
  });
}

test('a loader whose path is a parameter resolves to no path', async () => {
  // The frame is found; the path is not. Saying "unresolvable" is the honest
  // answer, and is what stops the fallback from offering a neighbour's columns.
  const res = await resolveProject({
    'loaders.py': `${PL}def load(source):\n    return pl.scan_parquet(source)\n`,
    'main.py': 'from loaders import load\nload().select("|")'
  }, 'main.py', ROOT);
  assert.equal(res.source?.path, undefined);
  assert.equal(res.failure, 'unresolvable-path');
});

test('an import cycle terminates', async () => {
  const res = await resolveProject({
    'a.py': `${PL}from b import y\nx = pl.scan_parquet("a.parquet")\n`,
    'main.py': 'from a import x\nx.select("|")',
    'b.py': 'from a import x\ny = x.filter(z)\n'
  }, 'main.py', ROOT);
  assert.equal(res.source?.path, 'a.parquet');
});

test('columns propagate through the module boundary', async () => {
  // The narrowing done in loaders.py has to survive the import, or the offer
  // downstream is the whole file again.
  const { tree, table } = await analyzeProject({
    'loaders.py': `${PL}def load():\n    return pl.scan_parquet("a.parquet").select("a", "b")\n`,
    'main.py': 'from loaders import load\nn = load()\nn.select("")'
  }, 'main.py', ROOT);
  const offset = tree.rootNode.text.lastIndexOf('""') + 1;
  const { resolveAtOffset } = await import('../harness.mjs');
  const res = resolveAtOffset(tree, table, offset);
  assert.ok(res.frame, 'no frame resolved');
  const columns = ['a', 'b', 'c'].map((name) => ({ name, dtype: 'i64' }));
  const evaluated = evaluateFrame(res.frame, () => columns, table);
  assert.deepEqual(evaluated.columns.map((c) => c.name), ['a', 'b']);
  assert.equal(evaluated.certain, true);
});

// --- the path arithmetic, on its own ---

test('module candidates cover both a file and a package', async () => {
  const got = moduleCandidates('loaders', path.join(path.sep, 'proj'), []);
  assert.deepEqual(got, [
    path.join(path.sep, 'proj', 'loaders.py'),
    path.join(path.sep, 'proj', 'loaders', '__init__.py')
  ]);
});

test('a dotted module becomes a directory walk', async () => {
  const got = moduleCandidates('pkg.loaders', path.join(path.sep, 'proj'), []);
  assert.equal(got[0], path.join(path.sep, 'proj', 'pkg', 'loaders.py'));
});

test('relative imports count their dots', async () => {
  const here = path.join(path.sep, 'proj', 'app');
  assert.equal(
    moduleCandidates('.loaders', here, [])[0],
    path.join(here, 'loaders.py')
  );
  assert.equal(
    moduleCandidates('..loaders', here, [])[0],
    path.join(path.sep, 'proj', 'loaders.py')
  );
});

test('an absolute import also tries the workspace roots', async () => {
  const roots = [path.join(path.sep, 'ws')];
  const got = moduleCandidates('loaders', path.join(path.sep, 'proj'), roots);
  assert.ok(got.includes(path.join(path.sep, 'ws', 'loaders.py')));
});

test('imports are read without building a table', async () => {
  const parser = await initParser(ROOT);
  const tree = parse(parser, [
    'import polars as pl',
    'import loaders',
    'import pkg.sources',
    'import loaders as ld',
    'from .relative import a',
    'from pkg.deep import b as c',
    'from everything import *'
  ].join('\n'));
  const got = readImports(tree).map((i) => `${i.module}:${i.name}:${i.local}`);
  assert.deepEqual(got, [
    'polars:null:pl',
    'loaders:null:loaders',
    'pkg.sources:null:pkg.sources',
    'loaders:null:ld',
    '.relative:a:a',
    'pkg.deep:b:c'
  ]);
});
