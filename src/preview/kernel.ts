import * as vscode from 'vscode';
import type { SeriesRead } from '../schema/series.js';
import { chartFetchSnippet, parseChartJson, type KernelTarget } from '../schema/kernelSeries.js';
import { trace } from '../log.js';

/**
 * The one seam that runs Python: it asks a live Jupyter kernel for the values of
 * a frame the file cannot give — the result of a `group_by`, a join, a computed
 * column — so the graph draws what the notebook actually holds rather than the
 * source behind it.
 *
 * It is deliberately optional at the edges. The Jupyter extension is reached by
 * id at runtime, never declared as a dependency, so a PolarSense that never
 * opens a notebook drags none of it in; and every failure — no extension, no
 * kernel, consent declined, a frame that will not serialize — returns a `miss`
 * rather than throwing, because the honest fallback is the file path this
 * extension was already built on. What it will not do is start a kernel or a
 * notebook: `getKernel` only answers for a session already running, which is the
 * whole reason this is an enhancement to one rather than a new way to begin one.
 */

/** The slice of `@vscode/jupyter-extension`'s Kernels API used here, and no more. */
interface JupyterExports {
  readonly kernels?: {
    getKernel(uri: vscode.Uri): Thenable<JupyterKernel | undefined>;
  };
}
interface JupyterKernel {
  executeCode(code: string, token: vscode.CancellationToken): AsyncIterable<KernelOutput>;
}
interface KernelOutput {
  items: readonly { mime: string; data: Uint8Array }[];
}

const JUPYTER_ID = 'ms-toolsai.jupyter';

/** Serializing a frame and crossing a kernel must not hang the panel open forever. */
const TIMEOUT_MS = 8000;

export interface KernelReadResult {
  read?: SeriesRead;
  /** Why there is no read. The caller shows the file instead and says why. */
  miss?: string;
}

/**
 * The values of `columns` from the frame `target` addresses, capped at
 * `maxRows`, read from the notebook's kernel. `{ read }` on success; `{ miss }`
 * — with a reason — on anything else, so the caller falls back to the file.
 */
export async function readChartFromKernel(
  notebookUri: vscode.Uri,
  target: KernelTarget,
  columns: string[],
  maxRows: number
): Promise<KernelReadResult> {
  const kernel = await getKernel(notebookUri);
  if (!kernel) return { miss: 'no-kernel' };

  const code = chartFetchSnippet(target, columns, maxRows);
  const canceller = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => canceller.cancel(), TIMEOUT_MS);
  const decoder = new TextDecoder();
  let text = '';
  try {
    for await (const output of kernel.executeCode(code, canceller.token)) {
      for (const item of output.items) {
        // The snippet prints its answer, so stdout (and text/plain, where a
        // kernel routes a print there) is where it is. An error mime means the
        // run itself failed — the snippet is written never to raise — so there
        // is nothing to parse and the file is the better answer.
        if (item.mime.includes('stdout') || item.mime === 'text/plain') {
          text += decoder.decode(item.data);
        } else if (item.mime.startsWith('application/vnd.code.notebook.error')) {
          return { miss: 'exec-error' };
        }
      }
    }
  } catch (err) {
    trace(`graph: kernel execute failed — ${message(err)}`);
    return { miss: 'exec-threw' };
  } finally {
    clearTimeout(timer);
    canceller.dispose();
  }

  const parsed = parseChartJson(text);
  if ('error' in parsed) {
    trace(`graph: kernel returned no frame — ${parsed.error}`);
    return { miss: parsed.error };
  }
  return { read: parsed.read };
}

/**
 * Whether a kernel-backed read is possible for this notebook at all — a started
 * kernel the user has consented to reach. Asked once when the panel opens so it
 * can decide between the two paths before drawing anything. This is also where
 * the Jupyter extension's own per-extension consent prompt appears the first
 * time; declining it simply leaves this returning false, and the file path runs.
 */
export async function kernelAvailable(notebookUri: vscode.Uri): Promise<boolean> {
  return !!(await getKernel(notebookUri));
}

async function getKernel(notebookUri: vscode.Uri): Promise<JupyterKernel | undefined> {
  const ext = vscode.extensions.getExtension<JupyterExports>(JUPYTER_ID);
  if (!ext) return undefined;
  try {
    const api = ext.isActive ? ext.exports : await ext.activate();
    const kernel = await api.kernels?.getKernel(notebookUri);
    return kernel ?? undefined;
  } catch (err) {
    trace(`graph: jupyter getKernel failed — ${message(err)}`);
    return undefined;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
