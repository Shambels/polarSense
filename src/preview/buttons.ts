import * as vscode from 'vscode';
import type { PolarSenseApi } from '../api.js';
import { readSettings } from '../config.js';
import { trace } from '../log.js';
import { lastStatementOffset } from './cells.js';
import { showDetails } from './details.js';
import { showData } from './table.js';
import { showGraph } from './graph.js';
import type { FrameTarget } from './target.js';

/**
 * The host half of the notebook renderer: a click under a cell's output, turned
 * into the same panel the command palette opens.
 *
 * The renderer draws the buttons and knows nothing else — no path, no schema,
 * not even which frame it is looking at. All it sends back is *which output was
 * clicked*, and everything after that is answered here, statically, from the
 * cell's own source. That is the seam: the day VS Code offers a supported way
 * to extend the built-in HTML renderer (issue #153836), the renderer is what
 * gets rewritten and this side does not move.
 */
export const RENDERER_ID = 'polarsense.dataframe';

/** What the page can ask for. Anything else is ignored rather than guessed at. */
interface FromRenderer {
  type?: string;
  command?: string;
  outputId?: string;
}

export function registerNotebookButtons(
  context: vscode.ExtensionContext,
  api: PolarSenseApi
): void {
  const messaging = vscode.notebooks.createRendererMessaging(RENDERER_ID);

  context.subscriptions.push(
    // The promise is handed back rather than dropped: VS Code ignores it, and a
    // test driving this can wait for the panel instead of racing it.
    messaging.onDidReceiveMessage(({ editor, message }) =>
      receive(api, messaging, editor, (message ?? {}) as FromRenderer)
    ),
    // The buttons are drawn already; turning them off has to reach the pages
    // that exist rather than only the ones drawn next.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('polarsense.notebook.buttons')) return;
      void messaging.postMessage(config());
    })
  );
}

function config(): { type: 'config'; buttons: boolean } {
  return { type: 'config', buttons: readSettings().notebookButtons };
}

async function receive(
  api: PolarSenseApi,
  messaging: vscode.NotebookRendererMessaging,
  editor: vscode.NotebookEditor,
  message: FromRenderer
): Promise<void> {
  // A page comes back with no state whenever its output is redrawn, so it asks
  // rather than the host guessing when to tell it.
  if (message.type === 'ready') {
    await messaging.postMessage(config(), editor);
    return;
  }

  const command = message.command;
  if (command !== 'showData' && command !== 'showDetails' && command !== 'showGraph') return;

  const cell = cellFor(editor, message.outputId);
  if (!cell) {
    // Nothing to read the source of, so nothing to say about the frame.
    vscode.window.showInformationMessage(
      'PolarSense: could not tell which cell that output belongs to. ' +
      'Put the cursor on the frame and use the command palette instead.'
    );
    return;
  }

  const target = cellTarget(cell);
  if (!target) return;

  trace(`notebook button ${command} on cell ${cell.index}`);
  const open = { showData, showDetails, showGraph }[command];
  await open(api, target);
}

/**
 * The frame this cell printed: its last statement, wherever the cursor is.
 *
 * The offset only has to land inside the right statement — the resolver walks
 * outward from there to the widest expression that still resolves, which is
 * also what makes `df.filter(…)` come back as a filtered frame rather than as
 * the bare file.
 */
function cellTarget(cell: vscode.NotebookCell): FrameTarget | undefined {
  const source = cell.document.getText();
  const offset = lastStatementOffset(source);
  if (offset === undefined) return undefined;

  return {
    uri: cell.document.uri,
    position: cell.document.positionAt(offset),
    missing:
      'PolarSense: this cell’s frame has no file behind it that can be found ' +
      'without running the code — it may be built in memory, or read from a ' +
      'path this analysis cannot fold down to a literal.'
  };
}

/**
 * Which cell that output belongs to.
 *
 * VS Code gives every output an id and hands it to the renderer as
 * `OutputItem.id`, but `NotebookCellOutput` does not carry it in the typed API —
 * so the match is made against a field that is there at runtime and may not
 * always be. When it misses, the focused cell is the answer, because clicking a
 * button inside an output is what focuses the cell holding it. Exact first,
 * plausible second, and nothing at all rather than a cell picked at random.
 */
function cellFor(
  editor: vscode.NotebookEditor,
  outputId: string | undefined
): vscode.NotebookCell | undefined {
  const cells = editor.notebook
    .getCells()
    .filter((cell) => cell.kind === vscode.NotebookCellKind.Code);

  if (outputId) {
    const owner = cells.find((cell) =>
      cell.outputs.some((output) => (output as { id?: string }).id === outputId)
    );
    if (owner) return owner;
  }

  const range = editor.selections?.[0] ?? editor.selection;
  if (!range || range.end <= range.start) return undefined;
  const focused = editor.notebook.cellAt(range.start);
  return focused?.kind === vscode.NotebookCellKind.Code ? focused : undefined;
}
