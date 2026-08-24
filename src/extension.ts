import * as vscode from 'vscode';
import { initParser } from './core/parser.js';
import { Analyzer } from './analysis.js';
import { SchemaService } from './schema/index.js';
import { ColumnCompletionProvider } from './completion/provider.js';
import { DataFileLinkProvider } from './links.js';
import { ColumnHoverProvider } from './hover.js';
import { readSettings } from './config.js';
import { initLog, setTrace, showLog, trace, warn } from './log.js';

const PYTHON: vscode.DocumentSelector = [
  { language: 'python', scheme: 'file' },
  { language: 'python', scheme: 'untitled' },
  { language: 'python', scheme: 'vscode-notebook-cell' }
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLog(context);
  const settings = readSettings();
  setTrace(settings.trace);

  const schemas = new SchemaService({
    cacheSize: settings.cacheSize,
    maxColumns: settings.maxColumns,
    httpsEnabled: settings.httpsEnabled,
    csvSniffBytes: settings.csvSniffBytes,
    csvInferDtypes: settings.csvInferDtypes
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'polarsense.showOutput';
  context.subscriptions.push(status);

  const reporter = {
    report(text: string, tooltip?: string) {
      status.text = `PolarSense: ${text}`;
      status.tooltip = tooltip ?? '';
    }
  };

  let parser;
  try {
    parser = await initParser(context.extensionPath);
  } catch (err) {
    warn(`could not start the Python parser: ${String(err)}`);
    vscode.window.showErrorMessage(
      'PolarSense could not start its Python parser. Column completions are disabled.'
    );
    return;
  }

  const analyzer = new Analyzer(parser);

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      PYTHON,
      new ColumnCompletionProvider(analyzer, schemas, reporter),
      '"', "'"
    ),
    vscode.languages.registerDocumentLinkProvider(PYTHON, new DataFileLinkProvider(analyzer)),
    vscode.languages.registerHoverProvider(PYTHON, new ColumnHoverProvider(analyzer, schemas))
  );

  // Show the status item only where it means something.
  const syncStatus = (editor: vscode.TextEditor | undefined) => {
    if (editor?.document.languageId === 'python') status.show();
    else status.hide();
  };
  syncStatus(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(syncStatus));

  // A data file rewritten on disk should not serve stale columns.
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{parquet,pq,csv,tsv,json,arrow,ipc,feather}'
  );
  const invalidate = (uri: vscode.Uri) => {
    trace(`invalidate ${uri.fsPath}`);
    schemas.invalidate(uri.fsPath);
  };
  watcher.onDidChange(invalidate);
  watcher.onDidCreate(invalidate);
  watcher.onDidDelete(invalidate);
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('polarsense')) return;
      const next = readSettings();
      setTrace(next.trace);
      schemas.updateOptions({
        cacheSize: next.cacheSize,
        maxColumns: next.maxColumns,
        httpsEnabled: next.httpsEnabled,
        csvSniffBytes: next.csvSniffBytes,
        csvInferDtypes: next.csvInferDtypes
      });
      schemas.clear();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('polarsense.clearCache', () => {
      schemas.clear();
      analyzer.drop('');
      vscode.window.showInformationMessage('PolarSense: schema cache cleared.');
    }),
    vscode.commands.registerCommand('polarsense.showOutput', () => showLog())
  );

  trace('PolarSense activated');
}

export function deactivate(): void {
  // Everything lives on context.subscriptions.
}
