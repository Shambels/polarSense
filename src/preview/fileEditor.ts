import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PolarSenseApi, ResolvedFrame } from '../api.js';
import { escape, PANEL_CSS } from './facts.js';
import { showDetailsFor } from './details.js';
import { showGraphFor } from './graph.js';
import { TableSession } from './table.js';
import { shell } from './table.page.js';
import { trace } from '../log.js';

/**
 * The data file, opened as itself.
 *
 * Everywhere else in this extension a frame is found by reading Python. Here
 * there is no Python to read: someone clicked a `.parquet` file, and the file
 * is the frame — no transforms, nothing inferred, nothing to be uncertain
 * about. So this is the thinnest layer in the preview folder. It resolves the
 * uri to a frame, hands it to the same `TableSession` the palette command uses,
 * and forwards the two buttons that page carries to the two panels that were
 * already written.
 *
 * Read-only, and read-only in the strong sense: `CustomReadonlyEditorProvider`
 * has no save path at all, so there is no code here that could write to a data
 * file even by accident.
 */

export const VIEW_TYPE = 'polarsense.dataFile';

class DataFileEditor implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly api: PolarSenseApi) {}

  /**
   * Nothing is held open. The readers take a path and read the bytes a page
   * needs when the page is asked for, so a document here is a uri and a dispose
   * with nothing to do — which is also why a four-million-row file opens as
   * fast as a small one.
   */
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => { /* no resource is held */ } };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };

    const resolved = await this.api.resolveFile(document.uri);
    if (!resolved) {
      panel.webview.html = unreadable(document.uri);
      return;
    }

    // Both are replaced when the file is rewritten under the tab, so everything
    // below reads these bindings rather than closing over the first values.
    let frame: ResolvedFrame = resolved;
    let session = new TableSession(this.api, panel.webview, frame, true);

    // The handlers hand their promise back. VS Code ignores it, but a test
    // driving this without an editor around it has nothing else to wait on.
    const listener = panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'details') return showDetailsFor(frame);
      if (message?.type === 'graph') return showGraphFor(this.api, frame);
      return session.handle(message);
    });

    // A script that writes this file while its editor is open is the ordinary
    // case, not an edge one — you run it, then look. The row count in the header
    // was read when the tab opened, so without this the grid would keep quoting
    // the file that has just been replaced.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(document.uri.fsPath)),
        path.basename(document.uri.fsPath)
      )
    );
    const reload = async () => {
      const next = await this.api.resolveFile(document.uri);
      if (!next) return; // Mid-write, or gone: keep what is on screen and say nothing.
      trace(`reloading viewer for ${document.uri.fsPath}`);
      frame = next;
      session = new TableSession(this.api, panel.webview, frame, true);
      // A rewritten file is a new table: the page it was on may not exist any
      // more, so the document starts over rather than paging into thin air.
      panel.webview.html = shell(panel.webview.cspSource);
    };
    watcher.onDidChange(() => void reload());
    watcher.onDidCreate(() => void reload());

    panel.onDidDispose(() => { listener.dispose(); watcher.dispose(); });
    panel.webview.html = shell(panel.webview.cspSource);
  }
}

export function registerDataFileEditor(
  context: vscode.ExtensionContext,
  api: PolarSenseApi
): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new DataFileEditor(api), {
      // Nothing to keep: a hidden webview is reloaded and asks for its page
      // again, which costs one read of a hundred rows.
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: true
    })
  );
}

/**
 * What a file that will not open says. It names the two things it can be —
 * not that format, or a footer this reader does not understand — because "could
 * not read" alone leaves you looking for a bug in the extension when the answer
 * is usually in the file.
 */
function unreadable(uri: vscode.Uri): string {
  const file = path.basename(uri.fsPath);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>${escape(file)}</title>
<style>${PANEL_CSS}</style>
</head>
<body>
<div class="head">
<h1>${escape(file)}</h1>
<p class="origin" title="${escape(uri.fsPath)}">${escape(uri.fsPath)}</p>
<p class="note">PolarSense could not read this file. Either it is not the format its
name claims, or it is written in a way this reader does not understand — the log
(<em>PolarSense: Show log</em>) says which. Reopen it with the built-in editor from
<em>View: Reopen Editor With…</em> to look at the bytes.</p>
</div>
</body>
</html>`;
}
