import * as vscode from 'vscode';
import type { Analyzer } from './analysis.js';
import type { SchemaService } from './schema/index.js';
import type { Column, SourceKind } from './core/types.js';
import { frameAtOffset } from './core/resolve.js';
import { framesSources } from './core/frame.js';
import { evaluateFrame } from './core/schemaEval.js';
import { assemble } from './notebook.js';
import { readSettings, workspaceDirs } from './config.js';
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
        rowCount: primary.schema.rowCount,
        sizeBytes: primary.schema.sizeBytes,
        rowGroups: primary.schema.rowGroups,
        compression: primary.schema.compression,
        certain: evaluated ? evaluated.certain : true,
        transformed: !!found.frame && found.frame.kind !== 'source',
        symbol: found.source.symbol
      };
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
