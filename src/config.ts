import * as vscode from 'vscode';

export interface Settings {
  enable: boolean;
  pathRoots: string[];
  fallbackToAllSchemas: boolean;
  maxColumns: number;
  csvSniffBytes: number;
  csvInferDtypes: boolean;
  httpsEnabled: boolean;
  followImports: boolean;
  cacheSize: number;
  diagnosticsEnabled: boolean;
  notebookButtons: boolean;
  valuesEnabled: boolean;
  valueMaxRows: number;
  valueMaxDistinct: number;
  graphMaxRows: number;
  graphUseKernel: boolean;
  trace: boolean;
}

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('polarsense');
  return {
    enable: config.get('enable', true),
    pathRoots: config.get<string[]>('pathRoots', []),
    fallbackToAllSchemas: config.get('fallbackToAllSchemas', true),
    maxColumns: config.get('maxColumns', 5000),
    csvSniffBytes: config.get('csv.sniffBytes', 262_144),
    csvInferDtypes: config.get('csv.inferDtypes', false),
    httpsEnabled: config.get('https.enabled', false),
    followImports: config.get('followImports', true),
    cacheSize: config.get('cacheSize', 200),
    diagnosticsEnabled: config.get('diagnostics.enable', true),
    notebookButtons: config.get('notebook.buttons', true),
    valuesEnabled: config.get('values.enable', false),
    valueMaxRows: config.get('values.maxRows', 10_000),
    valueMaxDistinct: config.get('values.maxDistinct', 50),
    graphMaxRows: config.get('graph.maxRows', 100_000),
    graphUseKernel: config.get('graph.useKernel', true),
    trace: config.get('trace', false)
  };
}

export function workspaceDirs(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath);
}
