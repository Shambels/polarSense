import type { Node } from 'web-tree-sitter';
import { callArguments, dottedName, lastSegment, stringValue } from './ast.js';

/**
 * `__file__`, before a `.parent` has taken it up a level. This module is pure —
 * it has no idea what the file on disk is called — but it does not need to
 * know: every path that comes out of here is resolved against the source file's
 * own directory first, which is exactly what `Path(__file__).parent` means. So
 * the script's own directory folds to the empty string and the caller's
 * existing relative resolution does the rest.
 *
 * The sentinel exists so that only `.parent` (or `os.path.dirname`) can consume
 * `__file__`. A bare `__file__` is a file, not a directory, and folding it to
 * "the directory this file is in" would be a lie — so it never escapes: the
 * exported wrapper below turns any value still carrying it into null.
 */
const SELF_FILE = ' __file__';

/**
 * Fold a path expression down to a string. Real code rarely inlines a literal,
 * so this covers the handful of shapes that actually appear:
 *
 *   "data/sales.parquet"          literal
 *   "data/" + name                concatenation of foldable parts
 *   f"data/sales.parquet"         f-string with no interpolation
 *   DATA / "sales.parquet"        Path division
 *   Path(DATA, "sales.parquet")   Path / PurePath constructor
 *   Path(__file__).parent / "s"   the script's own directory
 *   os.path.join(DATA, "s.pq")    join
 *   str(PATH)                     wrapper
 *   PATH                          module-level string constant, recursively
 *
 * Anything else returns null, and the frame simply gets no completions.
 */
export function constEval(
  node: Node | null,
  constants: Map<string, Node>,
  depth = 0
): string | null {
  const value = fold(node, constants, depth);
  if (value === null || value.includes(SELF_FILE)) return null;
  // `Path(__file__).parent` on its own is the file's own directory — a real
  // answer, since a directory resolves to the first file in it — but it is not
  // the empty string, which no path resolver would know what to do with.
  return value === '' ? '.' : value;
}

function fold(
  node: Node | null,
  constants: Map<string, Node>,
  depth = 0
): string | null {
  if (!node || depth > 8) return null;

  switch (node.type) {
    case 'string':
    case 'concatenated_string':
      return stringValue(node);

    case 'parenthesized_expression':
      return fold(node.namedChildren[0] ?? null, constants, depth + 1);

    case 'identifier': {
      // A builtin, so it is read before the constant table: nothing anyone binds
      // to the name would fold to a path anyway.
      if (node.text === '__file__') return SELF_FILE;
      const bound = constants.get(node.text);
      if (!bound || bound.id === node.id) return null;
      return fold(bound, constants, depth + 1);
    }

    case 'attribute': {
      // `.parent` is the only attribute here that says something about a path.
      // `.parents[1]` is a subscript and is left alone: one level up covers what
      // scripts actually write, and a wrong directory is worse than no answer.
      if (node.childForFieldName('attribute')?.text !== 'parent') return null;
      const object = fold(node.childForFieldName('object'), constants, depth + 1);
      return object === null ? null : parentOf(object);
    }

    case 'binary_operator': {
      const op = node.childForFieldName('operator')?.text;
      const left = fold(node.childForFieldName('left'), constants, depth + 1);
      const right = fold(node.childForFieldName('right'), constants, depth + 1);
      if (left === null || right === null) return null;
      if (op === '+') return left + right;
      if (op === '/') return joinSegments(left, right); // pathlib division
      return null;
    }

    case 'call': {
      const callee = node.childForFieldName('function');
      const name = dottedName(callee);
      // `dottedName` gives up when the receiver is itself a call, so
      // `Path(__file__).resolve()` has no dotted name at all. The method's own
      // name is still what decides here, and the receiver is folded separately.
      const short = lastSegment(name) ??
        (callee?.type === 'attribute'
          ? callee.childForFieldName('attribute')?.text ?? null
          : null);
      const { positional } = callArguments(node);
      const parts: string[] = [];
      for (const arg of positional) {
        const value = fold(arg, constants, depth + 1);
        if (value === null) return null;
        parts.push(value);
      }
      if (short === 'str' || short === 'os.fspath' || short === 'fspath') {
        return parts.length === 1 ? parts[0] : null;
      }
      if (short === 'Path' || short === 'PurePath' || short === 'PosixPath' || short === 'WindowsPath') {
        return parts.length ? parts.reduce(joinSegments) : null;
      }
      if (name === 'os.path.join' || short === 'join') {
        return parts.length ? parts.reduce(joinSegments) : null;
      }
      if (name === 'os.path.abspath' || name === 'os.path.realpath') {
        // A path that is already relative to the file resolves the same either
        // way, so making it absolute is a no-op here.
        return parts.length === 1 ? parts[0] : null;
      }
      if (name === 'os.path.dirname' || short === 'dirname') {
        // The `os.path` spelling of `.parent`, and the one `__file__` usually
        // arrives in in code written before pathlib.

        return parts.length === 1 ? parentOf(parts[0]) : null;
      }
      if (short === 'expanduser' || short === 'resolve' || short === 'absolute') {
        // `Path("~/x").expanduser()` — the receiver carries the value.
        const receiver = callee?.childForFieldName('object');
        return fold(receiver ?? null, constants, depth + 1);
      }
      return null;
    }

    default:
      return null;
  }
}

function joinSegments(left: string, right: string): string {
  if (right.startsWith('/') || /^[a-zA-Z]+:\/\//.test(right)) return right;
  if (!left) return right;
  return left.endsWith('/') ? left + right : `${left}/${right}`;
}

/**
 * One level up. The source file's own directory is the empty string (see
 * `SELF_FILE`), so its parent is `..` and each level above appends another —
 * a relative path the caller resolves exactly as it resolves any other.
 */
function parentOf(value: string): string {
  if (value === SELF_FILE) return '';
  if (value === '') return '..';
  if (value === '..' || value.endsWith('/..')) return `${value}/..`;
  const trimmed = value.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut > 0) return trimmed.slice(0, cut);
  if (cut === 0) return '/'; // "/data" — the root, not the empty string
  return '';
}

/**
 * Module-level (and enclosing-function-level) names bound to a single expression,
 * used as the constant environment above. Last assignment wins, which matches how
 * a script reads top to bottom.
 */
export function collectConstants(root: Node): Map<string, Node> {
  const constants = new Map<string, Node>();
  const visit = (node: Node) => {
    if (node.type === 'assignment') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (left?.type === 'identifier' && right) constants.set(left.text, right);
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
  return constants;
}
