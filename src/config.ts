import * as vscode from 'vscode';

export interface Settings {
  enable: boolean;
  pathRoots: string[];
  fallbackToAllSchemas: boolean;
  maxColumns: number;
  csvSniffBytes: number;
  csvInferDtypes: boolean;
  httpsEnabled: boolean;
  cacheSize: number;
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
    cacheSize: config.get('cacheSize', 200),
    trace: config.get('trace', false)
  };
}

export function workspaceDirs(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath);
}
