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

class Diagnostic {
  constructor(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}

class WorkspaceEdit {
  constructor() {
    this.edits = [];
  }
  replace(uri, range, newText) {
    this.edits.push({ uri, range, newText });
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
  const registered = {
    providers: [], linkProviders: [], hoverProviders: [], codeActionProviders: [],
    diagnostics: null, commands: new Map(), configHandlers: [], webviews: [],
    // The notebook renderer's end of the wire: the handler the extension
    // registered, and everything it has posted back to a page.
    renderer: null,
    // Keys VS Code's configuration registry does not hold in this window. The
    // manifest declares every setting, so this is empty until a test says
    // otherwise — see unregisterSetting.
    unregistered: new Set(), executed: []
  };
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
    _settings: defaults,
    Position,
    Range,
    CompletionItem,
    CompletionList,
    CodeAction,
    CodeActionKind: { QuickFix: 'quickfix' },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Diagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    DocumentLink,
    Hover,
    MarkdownString,
    WorkspaceEdit,
    CompletionItemKind: { Field: 4 },
    NotebookCellKind: { Markup: 1, Code: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    Uri: {
      file: (p) => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` }),
      parse: (u) => ({ scheme: u.split(':')[0], fsPath: u, path: u, toString: () => u })
    },
    window: {
      activeTextEditor: undefined,
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '' }),
      showErrorMessage: (m) => { registered.error = m; },
      showInformationMessage: (m) => { registered.info = m; },
      // Enough of a webview to see what the extension put in it: the panel is
      // reused across calls in the real editor too, so the tests reuse one.
      createWebviewPanel: (viewType, title, showOptions, options) => {
        const panel = {
          viewType, title, showOptions, options,
          // Both directions of the protocol: what the extension sent to be
          // drawn, and the handler a click in the page would reach.
          messages: [],
          webview: {
            html: '',
            cspSource: 'vscode-webview://stub',
            postMessage: (message) => { panel.messages.push(message); return Promise.resolve(true); },
            onDidReceiveMessage: (handler) => {
              panel.receive = handler;
              return { dispose() {} };
            }
          },
          reveal: (column, preserveFocus) => { panel.revealed = { column, preserveFocus }; },
          onDidDispose: () => ({ dispose() {} }),
          dispose() {}
        };
        registered.webviews.push(panel);
        return panel;
      },
      onDidChangeActiveTextEditor: noopEvent
    },
    workspace: {
      workspaceFolders,
      notebookDocuments: [],
      getConfiguration: () => ({
        get: (key, fallback) => defaults[key] ?? fallback,
        // A key the registry does not hold has no default; that is the shape
        // VS Code reports, and what update() would refuse to write.
        inspect: (key) => (registered.unregistered.has(key)
          ? { key, defaultValue: undefined }
          : { key, defaultValue: defaults[key] }),
        update: (key, value) => {
          if (registered.unregistered.has(key)) {
            throw new Error(
              `Unable to write to User Settings because polarsense.${key} is not a registered configuration.`
            );
          }
          defaults[key] = value;
          for (const handler of registered.configHandlers) {
            handler({ affectsConfiguration: () => true });
          }
        }
      }),
      createFileSystemWatcher: () => ({
        onDidChange: noopEvent, onDidCreate: noopEvent, onDidDelete: noopEvent, dispose() {}
      }),
      onDidChangeConfiguration: (handler) => {
        registered.configHandlers.push(handler);
        return { dispose() {} };
      },
      textDocuments: [],
      onDidOpenTextDocument: noopEvent,
      onDidChangeTextDocument: noopEvent,
      onDidCloseTextDocument: noopEvent,
      onDidSaveTextDocument: noopEvent
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
      },
      registerCodeActionsProvider: (selector, provider) => {
        registered.codeActionProviders.push({ selector, provider });
        return { dispose() {} };
      },
      createDiagnosticCollection: (name) => {
        const store = new Map();
        const collection = {
          name,
          set: (uri, diags) => store.set(uri.toString(), diags),
          delete: (uri) => store.delete(uri.toString()),
          get: (uri) => store.get(uri.toString()) ?? [],
          clear: () => store.clear(),
          dispose: () => store.clear()
        };
        registered.diagnostics = collection;
        return collection;
      }
    },
    notebooks: {
      createRendererMessaging: (rendererId) => {
        const wire = { rendererId, receive: undefined, posted: [] };
        registered.renderer = wire;
        return {
          onDidReceiveMessage: (handler) => {
            wire.receive = (message) => handler(message);
            return { dispose() {} };
          },
          postMessage: (message, editor) => {
            wire.posted.push({ message, editor });
            return Promise.resolve(true);
          }
        };
      }
    },
    commands: {
      registerCommand: (name, fn) => {
        registered.commands.set(name, fn);
        return { dispose() {} };
      },
      executeCommand: (name, ...args) => {
        registered.executed.push([name, ...args]);
        return Promise.resolve();
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
    document: documentOver(
      text,
      { scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` }
    ),
    position: positionAt(offset === -1 ? 0 : offset)
  };
}

/** A TextDocument over a string, whatever uri it is meant to have. */
function documentOver(text, uri) {
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
  return { uri, version: 1, languageId: 'python', getText: () => text, positionAt, offsetAt };
}

/**
 * A notebook and the editor showing it: one code cell per source string, each
 * with an output carrying an id, which is what the renderer sends back when a
 * button under it is clicked.
 *
 * The cell documents are `vscode-notebook-cell` uris over the notebook's own
 * path, which is what makes the assembler treat them as cells of one file
 * rather than as unrelated scripts.
 */
export function makeNotebook(sources, fsPath) {
  const notebookUri = {
    scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}`
  };
  const cells = sources.map((source, index) => {
    const uri = {
      scheme: 'vscode-notebook-cell',
      fsPath,
      path: fsPath,
      toString: () => `vscode-notebook-cell://${fsPath}#ch${index}`
    };
    return {
      index,
      kind: 2,
      document: documentOver(source, uri),
      outputs: [{ id: `out-${index}`, items: [] }]
    };
  });

  const notebook = {
    uri: notebookUri,
    notebookType: 'jupyter-notebook',
    cellCount: cells.length,
    getCells: () => cells,
    cellAt: (index) => cells[index]
  };
  for (const cell of cells) cell.notebook = notebook;

  const editor = { notebook, selection: { start: 0, end: 1 }, selections: [{ start: 0, end: 1 }] };
  const focus = (index) => {
    editor.selection = { start: index, end: index + 1 };
    editor.selections = [editor.selection];
  };
  focus(cells.length - 1);

  return { notebook, editor, cells, focus, documents: cells.map((cell) => cell.document) };
}

export const noCancel = { isCancellationRequested: false, onCancellationRequested: noopEvent };

/**
 * Change a setting the way VS Code does: write it, then tell the extension. The
 * extension caches some settings in services at activation, so a test that only
 * writes the value is testing something the user cannot do.
 */
export function setSetting(vscode, key, value) {
  vscode._settings[key] = value;
  for (const handler of vscode._registered.configHandlers) {
    handler({ affectsConfiguration: () => true });
  }
}

/**
 * Take a key out of the configuration registry, leaving the command that writes
 * it running: what a window holding two copies of the extension looks like.
 */
export function unregisterSetting(vscode, key) {
  vscode._registered.unregistered.add(key);
}
