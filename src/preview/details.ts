import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PolarSenseApi, ResolvedFrame } from '../api.js';
import { cursorTarget, NO_PYTHON, type FrameTarget } from './target.js';
import { renderDetails } from './details.page.js';

/**
 * The hover, in a panel, with a row per column instead of a tooltip for one.
 *
 * Everything here is already in hand: dtype, null count, min and max come out of
 * the parquet footer the schema read paid for, and so do the row count, the row
 * groups and the codec. Nothing on this panel reads a row — which is why it can
 * open on a four-million-row file as fast as on a small one, and why there is no
 * setting guarding it the way `values.enable` guards value completion.
 *
 * What the footer cannot give is left off rather than guessed: no distinct
 * counts (a column read), no mean or quantiles (every value). Four exact
 * statistics beat eight where half are estimates.
 */
let panel: vscode.WebviewPanel | undefined;

export async function showDetails(api: PolarSenseApi, at?: FrameTarget): Promise<void> {
  const target = at ?? cursorTarget();
  if (!target) {
    vscode.window.showInformationMessage(NO_PYTHON);
    return;
  }

  const frame = await api.resolveFrameAt(target.uri, target.position);
  if (!frame) {
    // The panel opens on a frame, so there has to be one where we looked.
    // Saying which is missing beats an empty panel that looks like a failed read.
    vscode.window.showInformationMessage(target.missing);
    return;
  }

  showDetailsFor(frame);
}

/**
 * The same panel on a frame the caller already has — the Details button in the
 * parquet editor, where there is no cursor to resolve and nothing to fail.
 */
export function showDetailsFor(frame: ResolvedFrame): void {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'polarsense.details',
      'PolarSense',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // Nothing on this page needs to run, so nothing is allowed to. A column
      // name comes out of a data file, and a file is not something to trust.
      { enableScripts: false }
    );
    panel.onDidDispose(() => { panel = undefined; });
  }

  panel.title = path.basename(frame.uri) || 'PolarSense';
  panel.webview.html = renderDetails(frame);
  // Beside and without focus: this is something to glance at while typing, and
  // stealing the cursor would undo the position it was just read from.
  panel.reveal(vscode.ViewColumn.Beside, true);
}
