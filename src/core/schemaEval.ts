import type { Column, SourceRef } from './types.js';
import type { FrameExpr, Transform } from './frame.js';
import { exprNames, type ExprContext, type NameSet } from './exprNames.js';

export interface EvaluatedSchema {
  columns: Column[];
  /**
   * False when something in the chain could not be modelled — an unmodelled
   * reshape, a selector, a computed name. The columns are then a best guess and
   * the caller should say so rather than present them as fact.
   */
  certain: boolean;
}

/** Resolves a source to the columns of the file it reads. */
export type SchemaLookup = (source: SourceRef) => Column[] | undefined;

/**
 * Walk the frame expression, applying each transform to the column list.
 *
 * The rule throughout: when a step cannot be modelled, keep the columns we had
 * and drop `certain` — narrowing wrongly is worse than admitting uncertainty,
 * because a column that exists and is not offered looks like a broken feature,
 * while an extra column merely looks generous.
 */
export function evaluateFrame(
  expr: FrameExpr,
  lookup: SchemaLookup,
  ctx: ExprContext
): EvaluatedSchema | null {
  switch (expr.kind) {
    case 'source': {
      const columns = lookup(expr.source);
      return columns ? { columns, certain: true } : null;
    }

    case 'transform': {
      const input = evaluateFrame(expr.input, lookup, ctx);
      if (!input) return null;
      return applyTransform(expr.op, input, expr.input, lookup, ctx);
    }

    case 'join': {
      const left = evaluateFrame(expr.left, lookup, ctx);
      const right = evaluateFrame(expr.right, lookup, ctx);
      if (!left) return null;
      if (!right) return { columns: left.columns, certain: false };

      if (expr.how === 'semi' || expr.how === 'anti') {
        return { columns: left.columns, certain: left.certain && right.certain };
      }

      const dropped = new Set(expr.on.unknown ? [] : expr.on.shared);
      const taken = new Set(left.columns.map((c) => c.name));
      const columns = [...left.columns];
      for (const column of right.columns) {
        if (dropped.has(column.name)) continue;
        // A name on both sides gets the suffix, exactly as polars does. With no
        // suffix — the shape a SQL statement's tables are folded into — the two
        // are the same reference, so it is offered once.
        if (taken.has(column.name) && !expr.suffix) continue;
        const name = taken.has(column.name) ? `${column.name}${expr.suffix}` : column.name;
        taken.add(name);
        columns.push({ ...column, name });
      }
      return { columns, certain: left.certain && right.certain && !expr.on.unknown };
    }
  }
}

function applyTransform(
  op: Transform,
  input: EvaluatedSchema,
  inputExpr: FrameExpr,
  lookup: SchemaLookup,
  ctx: ExprContext
): EvaluatedSchema {
  const byName = new Map(input.columns.map((c) => [c.name, c]));
  const keep = (name: string): Column => byName.get(name) ?? { name, dtype: '' };

  switch (op.op) {
    case 'identity':
      return input;

    case 'opaque':
      // We know the frame changed shape; we do not know how.
      return { columns: input.columns, certain: false };

    case 'select': {
      const resolved = resolveExprs(op.exprs, op.named, input.columns, ctx);
      if (!resolved) return { columns: input.columns, certain: false };
      return { columns: resolved.map(keep), certain: input.certain };
    }

    case 'with_columns': {
      const resolved = resolveExprs(op.exprs, op.named, input.columns, ctx);
      if (!resolved) return { columns: input.columns, certain: false };
      const columns = [...input.columns];
      const seen = new Set(columns.map((c) => c.name));
      for (const name of resolved) {
        if (seen.has(name)) continue; // replaces in place, keeping position
        seen.add(name);
        columns.push({ name, dtype: '' });
      }
      return { columns, certain: input.certain };
    }

    case 'drop': {
      const resolved = resolveExprs(op.exprs, [], input.columns, ctx);
      if (!resolved) return { columns: input.columns, certain: false };
      const gone = new Set(resolved);
      return {
        columns: input.columns.filter((c) => !gone.has(c.name)),
        certain: input.certain
      };
    }

    case 'rename': {
      const map = new Map(op.pairs);
      return {
        columns: input.columns.map((c) =>
          map.has(c.name) ? { ...c, name: map.get(c.name)! } : c
        ),
        certain: input.certain && !op.unknown
      };
    }

    case 'with_row_index':
      return {
        columns: [{ name: op.name, dtype: 'u32' }, ...input.columns],
        certain: input.certain
      };

    case 'group_by':
      // The frame handed to `.agg(…)` still has every column of its input; the
      // narrowing happens in agg, not here.
      return input;

    case 'agg': {
      const keys = groupKeys(inputExpr, input.columns, ctx);
      const aggregated = resolveExprs(op.exprs, op.named, input.columns, ctx);
      if (!keys || !aggregated) return { columns: input.columns, certain: false };
      const columns: Column[] = [];
      const seen = new Set<string>();
      for (const name of [...keys, ...aggregated]) {
        if (seen.has(name)) continue;
        seen.add(name);
        columns.push(keep(name));
      }
      return { columns, certain: input.certain };
    }
  }
  void lookup;
}

/** The keys of the `group_by` immediately below an `agg`. */
function groupKeys(expr: FrameExpr, columns: Column[], ctx: ExprContext): string[] | null {
  if (expr.kind !== 'transform' || expr.op.op !== 'group_by') return [];
  return resolveExprs(expr.op.exprs, expr.op.named, columns, ctx);
}

/**
 * Turn a list of expression nodes into the column names they produce.
 * Returns null when any of them is not statically knowable.
 */
function resolveExprs(
  exprs: { type: string }[] | readonly unknown[],
  named: [string, unknown][],
  columns: Column[],
  ctx: ExprContext
): string[] | null {
  const out: string[] = [];
  for (const node of exprs as Parameters<typeof exprNames>[0][]) {
    const set = exprNames(node, ctx);
    const names = expand(set, columns);
    if (!names) return null;
    out.push(...names);
  }
  // `df.with_columns(total=…)` — the keyword is the output name.
  for (const [name] of named) out.push(name);
  return out;
}

function expand(set: NameSet, columns: Column[]): string[] | null {
  switch (set.kind) {
    case 'names': return set.names;
    case 'all': return columns.map((c) => c.name);
    case 'except': {
      const gone = new Set(set.names);
      return columns.map((c) => c.name).filter((n) => !gone.has(n));
    }
    case 'match': {
      // A dtype selector cannot be applied to columns whose dtype we never read
      // — a CSV without inference, a column added upstream — so say so instead.
      if (set.needsDtype && columns.some((c) => !c.dtype)) return null;
      return columns.filter((c) => set.test(c)).map((c) => c.name);
    }
    case 'unknown': return null;
  }
}
