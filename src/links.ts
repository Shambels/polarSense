import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Analyzer } from './analysis.js';
import { resolvePath, type PathContext } from './paths.js';
import { readSettings, workspaceDirs } from './config.js';
import { schemeOf } from './storage/index.js';
import { trace } from './log.js';

/**
 * Turns the path in `pl.scan_parquet("data/sales.parquet")` into a ctrl-clickable
 * link to the actual file. The resolver already works out where that path points;
 * this just exposes the answer somewhere other than a completion list.
 */
export class DataFileLinkProvider implements vscode.DocumentLinkProvider {
  constructor(private analyzer: Analyzer) {}

  async provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.DocumentLink[]> {
    const settings = readSettings();
    if (!settings.enable) return [];

    const text = document.getText();
    const analysis = this.analyzer.get(
      `${document.uri.toString()}:${document.version}`,
      text
    );
    if (!analysis.table.sourceSites.length) return [];

    const ctx: PathContext = {
      documentDir: path.dirname(document.uri.fsPath),
      workspaceDirs: workspaceDirs(),
      extraRoots: settings.pathRoots
    };

    const links: vscode.DocumentLink[] = [];
    for (const site of analysis.table.sourceSites) {
      if (token.isCancellationRequested) break;
      const resolved = await resolvePath(site.source, ctx);
      if (!resolved) continue;

      const target = schemeOf(resolved.uri) === 'file'
        ? vscode.Uri.file(resolved.uri)
        : vscode.Uri.parse(resolved.uri);

      const link = new vscode.DocumentLink(
        new vscode.Range(document.positionAt(site.start), document.positionAt(site.end)),
        target
      );
      // A glob or a directory resolves to one concrete file — say which, since the
      // text under the cursor does not name it.
      link.tooltip = resolved.uri === site.source.path
        ? undefined
        : `Open ${resolved.uri}`;
      links.push(link);
    }
    trace(`links: ${links.length} of ${analysis.table.sourceSites.length} sites resolved`);
    return links;
  }
}
