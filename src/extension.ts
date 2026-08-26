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
import { createApi, type PolarSenseApi } from './api.js';
import { showDetails } from './preview/details.js';

const PYTHON: vscode.DocumentSelector = [
  { language: 'python', scheme: 'file' },
  { language: 'python', scheme: 'untitled' },
  { language: 'python', scheme: 'vscode-notebook-cell' }
];

export async function activate(
  context: vscode.ExtensionContext
): Promise<PolarSenseApi | undefined> {
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

  // The panel is a caller of the API, not a second copy of the resolver: what
  // ships in this VSIX today and what may ship in its own tomorrow ask the same
  // question the same way.
  const api = createApi(analyzer, schemas, modules);

  context.subscriptions.push(
    vscode.commands.registerCommand('polarsense.showDetails', () => showDetails(api)),
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

  // The resolver is the part of this nobody else has. Handing it out costs an
  // object and makes the viewer's eventual move to its own extension a change of
  // packaging rather than of code — undefined when the parser never started, so
  // a caller checks once instead of catching per call.
  return api;
}

/**
 * The setting is the state; the commands just write it. Everything that reads
 * values already re-reads the configuration, and the change event already
 * rewires the schema service — so there is nothing else to keep in step.
 *
 * The write can fail before it starts. VS Code refuses to write a key its
 * configuration registry does not hold, and the registry is filled from the
 * manifest of the extension copy the window resolved — which is not always the
 * copy whose code is running. A second PolarSense in the same window (a
 * Marketplace install alongside an Extension Development Host, or a folder an
 * interrupted update left in `.vscode/extensions`) makes the two diverge: the
 * duplicate manifest's properties are rejected as already registered, and if
 * the copy that did register is then dropped, the key is gone while the command
 * still runs. `update` answers that with "polarsense.values.enable is not a
 * registered configuration", which reads as a bug in the command rather than as
 * what it is — so ask first, and say the actionable thing instead.
 */
async function setValues(on: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration('polarsense');

  // inspect() reads the same registry update() validates against, so a default
  // that is missing here is exactly the write that would have thrown. The
  // declared default is `false`, never undefined, so this cannot misfire.
  if (config.inspect<boolean>('values.enable')?.defaultValue === undefined) {
    warn('values.enable is not in this window\'s configuration registry; the toggle cannot write it');
    const reload = 'Reload Window';
    const choice = await vscode.window.showErrorMessage(
      'PolarSense cannot change its settings in this window: polarsense.values.enable is not ' +
      'registered. Reload the window; if it persists, look for a second copy of PolarSense in ' +
      'the Extensions view and remove it.',
      reload
    );
    if (choice === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  }

  try {
    await config.update('values.enable', on, vscode.ConfigurationTarget.Global);
  } catch (err) {
    // Settings written by policy, a read-only settings.json — the write is the
    // whole command, so there is nothing to report but the failure.
    warn(`could not write values.enable: ${String(err)}`);
    vscode.window.showErrorMessage(`PolarSense could not change the setting: ${String(err)}`);
    return;
  }

  vscode.window.showInformationMessage(
    on
      ? 'PolarSense: value completion on. It reads rows of the parquet file behind your frame.'
      : 'PolarSense: value completion off. Only file metadata is read now.'
  );
}

export function deactivate(): void {
  // Everything lives on context.subscriptions.
}
