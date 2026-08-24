import type { Node } from 'web-tree-sitter';
import { callArguments, dottedName, lastSegment, stringValue } from './ast.js';

/**
 * Fold a path expression down to a string. Real code rarely inlines a literal,
 * so this covers the handful of shapes that actually appear:
 *
 *   "data/sales.parquet"          literal
 *   "data/" + name                concatenation of foldable parts
 *   f"data/sales.parquet"         f-string with no interpolation
 *   DATA / "sales.parquet"        Path division
 *   Path(DATA, "sales.parquet")   Path / PurePath constructor
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
  if (!node || depth > 8) return null;

  switch (node.type) {
    case 'string':
    case 'concatenated_string':
      return stringValue(node);

    case 'parenthesized_expression':
      return constEval(node.namedChildren[0] ?? null, constants, depth + 1);

    case 'identifier': {
      const bound = constants.get(node.text);
      if (!bound || bound.id === node.id) return null;
      return constEval(bound, constants, depth + 1);
    }

    case 'binary_operator': {
      const op = node.childForFieldName('operator')?.text;
      const left = constEval(node.childForFieldName('left'), constants, depth + 1);
      const right = constEval(node.childForFieldName('right'), constants, depth + 1);
      if (left === null || right === null) return null;
      if (op === '+') return left + right;
      if (op === '/') return joinSegments(left, right); // pathlib division
      return null;
    }

    case 'call': {
      const name = dottedName(node.childForFieldName('function'));
      const short = lastSegment(name);
      const { positional } = callArguments(node);
      const parts: string[] = [];
      for (const arg of positional) {
        const value = constEval(arg, constants, depth + 1);
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
      if (short === 'expanduser' || short === 'resolve' || short === 'absolute') {
        // `Path("~/x").expanduser()` — the receiver carries the value.
        const receiver = node.childForFieldName('function')?.childForFieldName('object');
        return constEval(receiver ?? null, constants, depth + 1);
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
