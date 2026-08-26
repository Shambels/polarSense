import * as vscode from 'vscode';
import { initParser } from './core/parser.js';
import { Analyzer } from './analysis.js';
import { ModuleService } from './modules.js';
import { showSchema } from './showSchema.js';
import { SchemaWarmer } from './warm.js';
import { SchemaService } from './schema/index.js';
import { ColumnCompletionProvider } from './completion/provider.js';
import { DataFileLinkProvider } from './links.js';
import { ColumnHoverProvider } from './hover.js';
import { ColumnDiagnostics, ColumnQuickFix } from './diagnostics.js';
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
    csvInferDtypes: settings.csvInferDtypes,
    valuesEnabled: settings.valuesEnabled,
    valueMaxRows: settings.valueMaxRows,
    valueMaxDistinct: settings.valueMaxDistinct
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  // The count is a link to the columns behind it, not just a debug readout.
  status.command = 'polarsense.showSchema';
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
  const modules = new ModuleService(parser);

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      PYTHON,
      new ColumnCompletionProvider(analyzer, schemas, modules, reporter),
      '"', "'"
    ),
    vscode.languages.registerDocumentLinkProvider(PYTHON, new DataFileLinkProvider(analyzer)),
    vscode.languages.registerHoverProvider(
      PYTHON, new ColumnHoverProvider(analyzer, schemas, modules)
    )
  );

  // Read what the open files name before anyone types, so the first completion
  // in a file is a cache hit rather than a round trip.
  const warmer = new SchemaWarmer(analyzer, schemas, modules);
  context.subscriptions.push(
    warmer,
    vscode.workspace.onDidOpenTextDocument((doc) => warmer.schedule(doc)),
    vscode.window.onDidChangeActiveTextEditor((editor) => warmer.schedule(editor?.document))
  );
  for (const doc of vscode.workspace.textDocuments) warmer.schedule(doc);

  const diagnostics = new ColumnDiagnostics(analyzer, schemas, modules);
  context.subscriptions.push(
    diagnostics,
    vscode.languages.registerCodeActionsProvider(
      PYTHON,
      new ColumnQuickFix(diagnostics),
      { providedCodeActionKinds: ColumnQuickFix.kinds }
    ),
    vscode.workspace.onDidOpenTextDocument((doc) => diagnostics.schedule(doc)),
    vscode.workspace.onDidChangeTextDocument((event) => diagnostics.schedule(event.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.clear(doc)),
    vscode.workspace.onDidSaveTextDocument((doc) => diagnostics.schedule(doc))
  );
  for (const doc of vscode.workspace.textDocuments) diagnostics.schedule(doc);

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
    // The columns just changed: anything we warned about may now be fine.
    for (const doc of vscode.workspace.textDocuments) diagnostics.schedule(doc);
  };
  watcher.onDidChange(invalidate);
  watcher.onDidCreate(invalidate);
  watcher.onDidDelete(invalidate);
  context.subscriptions.push(watcher);

  // A module the open file imports can define its frames; editing one elsewhere
  // should re-check this file. The parse cache notices the mtime by itself.
  const pythonWatcher = vscode.workspace.createFileSystemWatcher('**/*.py');
  const recheck = () => {
    for (const doc of vscode.workspace.textDocuments) diagnostics.schedule(doc);
  };
  pythonWatcher.onDidChange(recheck);
  pythonWatcher.onDidCreate(recheck);
  pythonWatcher.onDidDelete(recheck);
  context.subscriptions.push(pythonWatcher);

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
        csvInferDtypes: next.csvInferDtypes,
        valuesEnabled: next.valuesEnabled,
        valueMaxRows: next.valueMaxRows,
        valueMaxDistinct: next.valueMaxDistinct
      });
      schemas.clear();
      for (const doc of vscode.workspace.textDocuments) {
        diagnostics.schedule(doc);
        warmer.schedule(doc);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('polarsense.clearCache', () => {
      schemas.clear();
      modules.clear();
      analyzer.drop('');
      warmer.schedule(vscode.window.activeTextEditor?.document);
      vscode.window.showInformationMessage('PolarSense: schema cache cleared.');
    }),
    vscode.commands.registerCommand('polarsense.enableValues', () => setValues(true)),
    vscode.commands.registerCommand('polarsense.disableValues', () => setValues(false)),
    vscode.commands.registerCommand('polarsense.showOutput', () => showLog()),
    vscode.commands.registerCommand(
      'polarsense.showSchema', () => showSchema(analyzer, schemas, modules)
    )
  );

  trace('PolarSense activated');
}

/**
 * The setting is the state; the commands just write it. Everything that reads
 * values already re-reads the configuration, and the change event already
 * rewires the schema service — so there is nothing else to keep in step.
 */
async function setValues(on: boolean): Promise<void> {
  await vscode.workspace.getConfiguration('polarsense')
    .update('values.enable', on, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    on
      ? 'PolarSense: value completion on. It reads rows of the parquet file behind your frame.'
      : 'PolarSense: value completion off. Only file metadata is read now.'
  );
}

export function deactivate(): void {
  // Everything lives on context.subscriptions.
}
