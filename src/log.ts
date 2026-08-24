import * as vscode from 'vscode';

let channel: vscode.OutputChannel | null = null;
let traceEnabled = false;

export function initLog(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('PolarSense');
    context.subscriptions.push(channel);
  }
  return channel;
}

export function setTrace(enabled: boolean): void {
  traceEnabled = enabled;
}

/** Every resolution attempt, when tracing is on. This is what to ask for in a bug report. */
export function trace(message: string): void {
  if (!traceEnabled || !channel) return;
  channel.appendLine(`${new Date().toISOString().slice(11, 23)}  ${message}`);
}

export function warn(message: string): void {
  channel?.appendLine(`${new Date().toISOString().slice(11, 23)}  ! ${message}`);
}

export function showLog(): void {
  channel?.show(true);
}
