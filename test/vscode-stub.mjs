/**
 * Enough of the vscode API to activate the real bundled extension in plain node
 * and drive a completion request end to end. Not a substitute for running in an
 * editor, but it catches the failures that matter most: the bundle not loading,
 * activation throwing, and the provider returning nothing for a valid cursor.
 */
import Module from 'node:module';

export class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

export class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
  }
}

class CompletionList {
  constructor(items, isIncomplete) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

class DocumentLink {
  constructor(range, target) {
    this.range = range;
    this.target = target;
  }
}

class MarkdownString {
  constructor(value) {
    this.value = value ?? '';
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
}

class Hover {
  constructor(contents, range) {
    this.contents = contents;
    this.range = range;
  }
}

const noopEvent = () => ({ dispose() {} });

export function makeVscode(settings = {}, workspaceFolders = []) {
  const registered = { providers: [], linkProviders: [], hoverProviders: [], commands: new Map() };
  const defaults = {
    enable: true,
    pathRoots: [],
    fallbackToAllSchemas: true,
    maxColumns: 5000,
    'csv.sniffBytes': 262144,
    'csv.inferDtypes': false,
    'https.enabled': false,
    cacheSize: 200,
    trace: false,
    ...settings
  };

  const vscode = {
    _registered: registered,
    Position,
    Range,
    CompletionItem,
    CompletionList,
    DocumentLink,
    Hover,
    MarkdownString,
    CompletionItemKind: { Field: 4 },
    NotebookCellKind: { Markup: 1, Code: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    Uri: {
      file: (p) => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` }),
      parse: (u) => ({ scheme: u.split(':')[0], fsPath: u, path: u, toString: () => u })
    },
    window: {
      activeTextEditor: undefined,
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '' }),
      showErrorMessage: (m) => { registered.error = m; },
      showInformationMessage: () => {},
      onDidChangeActiveTextEditor: noopEvent
    },
    workspace: {
      workspaceFolders,
      notebookDocuments: [],
      getConfiguration: () => ({ get: (key, fallback) => defaults[key] ?? fallback }),
      createFileSystemWatcher: () => ({
        onDidChange: noopEvent, onDidCreate: noopEvent, onDidDelete: noopEvent, dispose() {}
      }),
      onDidChangeConfiguration: noopEvent
    },
    languages: {
      registerCompletionItemProvider: (selector, provider, ...triggers) => {
        registered.providers.push({ selector, provider, triggers });
        return { dispose() {} };
      },
      registerDocumentLinkProvider: (selector, provider) => {
        registered.linkProviders.push({ selector, provider });
        return { dispose() {} };
      },
      registerHoverProvider: (selector, provider) => {
        registered.hoverProviders.push({ selector, provider });
        return { dispose() {} };
      }
    },
    commands: {
      registerCommand: (name, fn) => {
        registered.commands.set(name, fn);
        return { dispose() {} };
      }
    }
  };
  return vscode;
}

/** Route `require('vscode')` in the bundle to our stub. */
export function installVscodeStub(vscode) {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return original.call(this, request, parent, isMain);
  };
  return () => { Module._load = original; };
}

/** A TextDocument over a source string, with `|` marking the cursor. */
export function makeDocument(marked, fsPath) {
  const offset = marked.indexOf('|');
  const text = offset === -1 ? marked : marked.slice(0, offset) + marked.slice(offset + 1);
  const lines = text.split('\n');

  const positionAt = (target) => {
    let remaining = target;
    for (let line = 0; line < lines.length; line++) {
      if (remaining <= lines[line].length) return new Position(line, remaining);
      remaining -= lines[line].length + 1;
    }
    return new Position(lines.length - 1, lines[lines.length - 1].length);
  };
  const offsetAt = (position) => {
    let total = 0;
    for (let line = 0; line < position.line; line++) total += lines[line].length + 1;
    return total + position.character;
  };

  return {
    document: {
      uri: { scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` },
      version: 1,
      languageId: 'python',
      getText: () => text,
      positionAt,
      offsetAt
    },
    position: positionAt(offset === -1 ? 0 : offset)
  };
}

export const noCancel = { isCancellationRequested: false, onCancellationRequested: noopEvent };
