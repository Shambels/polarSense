import * as vscode from 'vscode';

/**
 * Where a panel was asked to look.
 *
 * Both panels used to read the active editor's cursor themselves, which is one
 * way in. A button under a notebook output is a second: the position is in a
 * cell nobody's cursor is in. So the lookup moved out here and the panels take
 * the answer — same resolver, same failure, different door.
 */
export interface FrameTarget {
  uri: vscode.Uri;
  position: vscode.Position;
  /**
   * What to say when nothing resolves there. A cursor that is not on a frame
   * and a cell whose frame has no file behind it are different misses, and
   * telling someone to move a cursor they did not use is no help at all.
   */
  missing: string;
}

export const NO_PYTHON = 'PolarSense: open a Python file to see a frame.';

const NO_FRAME_AT_CURSOR =
  'PolarSense: no frame at the cursor. Put it on a DataFrame — the variable, ' +
  'or anywhere in the chain hanging off it.';

/** The frame the active editor's cursor is on, for the two commands. */
export function cursorTarget(): FrameTarget | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'python') return undefined;
  return {
    uri: editor.document.uri,
    position: editor.selection.active,
    missing: NO_FRAME_AT_CURSOR
  };
}
