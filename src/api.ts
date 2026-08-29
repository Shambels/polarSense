import * as vscode from 'vscode';
import type { Analyzer } from './analysis.js';
import type { SchemaService } from './schema/index.js';
import * as path from 'node:path';
import type { Column, SourceKind } from './core/types.js';
import type { RowPage, RowRequest } from './schema/rows.js';
import type { Chart, ChartRequest } from './schema/chart.js';
import { frameAtOffset } from './core/resolve.js';
import { framesSources } from './core/frame.js';
import { evaluateFrame } from './core/schemaEval.js';
import { assemble } from './notebook.js';
import { readSettings, workspaceDirs } from './config.js';
import { kindForFile } from './paths.js';
import { NO_MODULES, type ModuleService } from './modules.js';
import type { PathContext } from './paths.js';

/** Whoever called this asked for it and is waiting: a cold read may take a moment. */
const BUDGET_MS = 5000;

/** What the resolver knows about the frame at a position, and nothing more. */
export interface ResolvedFrame {
  /** The concrete file or table directory behind the frame, as a path or URL. */
  uri: string;
  kind: SourceKind;
  /** The columns that exist at that position, with the file's own statistics. */
  columns: Column[];
  /**
   * The file's own columns, before any transform. Equal to `columns` for an
   * untransformed frame; for a transformed one it is what can actually be read
   * from the file, which is what a viewer falls back to offering when it has no
   * kernel to compute the real columns from.
   */
  sourceColumns: Column[];
  /** Rows in the *file*, when the format records it — see `transformed`. */
  rowCount?: number;
  /**
   * What the file's own metadata says about the file rather than its columns:
   * its size, and for parquet the row groups and the codec they are written
   * with. All of it came out of the read the schema already paid for.
   */
  sizeBytes?: number;
  rowGroups?: number;
  compression?: string;
  /**
   * False when a transform on the way here could not be modelled, so `columns`
   * is a best guess. Anything shown from an uncertain answer should say so.
   */
  certain: boolean;
  /**
   * The frame is the source with transforms applied — a filter, a select, a
   * join. `uri` and `rowCount` still describe the file, so a caller reading
   * rows from it is reading the source, not the frame, and has to say which.
   */
  transformed: boolean;
  /** The variable the frame was bound to, when it had a name. */
  symbol?: string;
  /**
   * The literal reader arguments at the call site — `separator=`, `sheet_name=`.
   * They are what the same bytes mean, so paging the file needs them as much as
   * reading its header did.
   */
  kwargs: Record<string, string | number | boolean | string[] | null>;
}

/** Why a page could not be read. Every one of them is a sentence, not a failure. */
export type RowsFailure =
  | 'file-not-found'
  | 'unsupported-scheme'
  | 'unsupported-format'
  | 'read-failed';

export interface RowsResult {
  page?: RowPage;
  error?: RowsFailure;
}

export interface ChartResult {
  chart?: Chart;
  error?: RowsFailure;
}

/**
 * PolarSense's answer to "which file is this frame, and what is in it", exported
 * so another extension can ask it. The viewer in `docs/roadmap-v2.html` is the
 * caller this exists for: whether it ships inside this VSIX or its own, it asks
 * the same question, and going through `extensionDependencies` rather than an
 * import is what makes that a packaging decision rather than a rewrite.
 */
export interface PolarSenseApi {
  /** Bumped only for a breaking change to the shapes above. */
  readonly version: 1;
  /**
   * The frame at `position`, or undefined when there is none there, when its
   * file cannot be found, or when the schema cannot be read. The position is on
   * the frame — a variable, a method chain — not inside a column name, though
   * a cursor in either lands on the same frame.
   */
  resolveFrameAt(uri: vscode.Uri, position: vscode.Position): Promise<ResolvedFrame | undefined>;
  /**
   * A data file as a frame, for a caller holding a file rather than a cursor —
   * the parquet viewer opens on one of these. Same shape as `resolveFrameAt`
   * returns, with `transformed` false and `certain` true, because the file's own
   * schema is not a guess about anything.
   *
   * Undefined when the extension names no reader here, or when the schema
   * cannot be read — a file that is not the format its name claims is the
   * common case, and it is a miss rather than an error.
   */
  resolveFile(uri: vscode.Uri): Promise<ResolvedFrame | undefined>;
  /**
   * A page of the file behind a frame `resolveFrameAt` returned: this row range,
   * these columns, nothing else. Rows are read only when this is called, and
   * only the cells asked for are read — so a caller that draws a hundred rows of
   * four columns costs a hundred rows of four columns, whatever the file weighs.
   *
   * It reads the *file*. A frame with a filter on it is not this, and
   * `ResolvedFrame.transformed` is how a caller knows to say so.
   */
  readRows(frame: ResolvedFrame, request: RowRequest): Promise<RowsResult>;
  /**
   * The shape of one or two of that file's columns: a histogram, a bar of
   * counts, a line, a scatter — chosen from the dtypes unless `kind` says
   * otherwise, and computed here.
   *
   * Aggregating on this side of the call is the point of it. What comes back is
   * at most a few hundred points whatever the file weighs, so a caller drawing
   * a four-million-row column never holds four million values — and the caller
   * cannot get them from here even if it wanted them.
   */
  readChart(frame: ResolvedFrame, request: ChartRequest): Promise<ChartResult>;
}

export function createApi(
  analyzer: Analyzer,
  schemas: SchemaService,
  modules: ModuleService
): PolarSenseApi {
  return {
    version: 1,

    async resolveFrameAt(uri, position) {
      const document = await openDocument(uri);
      if (!document || document.languageId !== 'python') return undefined;

      const settings = readSettings();
      const assembled = assemble(document, position);
      const moduleSet = settings.followImports
        ? await modules.load(analyzer.tree(assembled.key, assembled.source), {
            documentDir: assembled.documentDir,
            workspaceDirs: workspaceDirs()
          })
        : NO_MODULES;
      const analysis = analyzer.get(assembled.key, assembled.source, moduleSet);
      const found = frameAtOffset(analysis.tree, analysis.table, assembled.offset);
      if (!found) return undefined;

      const ctx: PathContext = {
        documentDir: assembled.documentDir,
        workspaceDirs: workspaceDirs(),
        extraRoots: settings.pathRoots
      };
      const sources = found.frame ? framesSources(found.frame) : [found.source];
      const results = await Promise.all(
        sources.map((source) => schemas.getWithBudget(source, ctx, BUDGET_MS))
      );
      const primary = results[0];
      if (!primary?.schema) return undefined;

      const byIndex = new Map(sources.map((source, i) => [source, results[i]?.schema?.columns]));
      const evaluated = found.frame
        ? evaluateFrame(found.frame, (source) => byIndex.get(source), analysis.table)
        : null;

      return {
        uri: primary.uri ?? primary.schema.origin,
        kind: found.source.kind,
        columns: evaluated?.columns ?? primary.schema.columns,
        sourceColumns: primary.schema.columns,
        rowCount: primary.schema.rowCount,
        sizeBytes: primary.schema.sizeBytes,
        rowGroups: primary.schema.rowGroups,
        compression: primary.schema.compression,
        certain: evaluated ? evaluated.certain : true,
        transformed: !!found.frame && found.frame.kind !== 'source',
        symbol: found.source.symbol,
        kwargs: found.source.kwargs
      };
    },

    async resolveFile(uri) {
      const file = uri.fsPath;
      const kind = kindForFile(file);
      if (!kind) return undefined;

      // An absolute path needs no roots to be searched, but the schema service
      // takes a context, and the file's own directory is the honest answer for
      // the one thing it is used for.
      const result = await schemas.get(
        { kind, path: file, kwargs: {} },
        { documentDir: path.dirname(file), workspaceDirs: [], extraRoots: [] }
      );
      if (!result.schema) return undefined;

      return {
        uri: result.uri ?? result.schema.origin,
        kind,
        columns: result.schema.columns,
        sourceColumns: result.schema.columns,
        rowCount: result.schema.rowCount,
        sizeBytes: result.schema.sizeBytes,
        rowGroups: result.schema.rowGroups,
        compression: result.schema.compression,
        // Nothing was inferred and nothing was applied: this is the file.
        certain: true,
        transformed: false,
        kwargs: {}
      };
    },

    async readRows(frame, request) {
      // The uri came from `resolveFrameAt`, which means it is the concrete file
      // rather than what the source line said — already globbed, already the
      // member file of a hive directory. Resolving it again is a stat.
      const result = await schemas.rows(
        { kind: frame.kind, path: frame.uri, kwargs: frame.kwargs },
        { documentDir: path.dirname(frame.uri), workspaceDirs: [], extraRoots: [] },
        request
      );
      return { page: result.page, error: result.error };
    },

    async readChart(frame, request) {
      const result = await schemas.chart(
        { kind: frame.kind, path: frame.uri, kwargs: frame.kwargs },
        { documentDir: path.dirname(frame.uri), workspaceDirs: [], extraRoots: [] },
        request
      );
      return { chart: result.chart, error: result.error };
    }
  };
}

/**
 * A caller has a uri, not a document. An open one is used as it stands — an
 * unsaved edit is the version the user is looking at, and a notebook cell only
 * exists as an open document at all.
 */
async function openDocument(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  const key = uri.toString();
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === key);
  if (open) return open;
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    // A uri that is not a file we can read is a "no frame here", not an error.
    return undefined;
  }
}
