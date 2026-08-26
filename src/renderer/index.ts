import { looksLikeFrame } from '../preview/cells.js';

/**
 * The buttons under a cell's output.
 *
 * A panel opens beside your code; the brief asked for something attached to the
 * output itself, and that means a notebook renderer. VS Code has no supported
 * way to *add* to the built-in HTML renderer — issue #153836 is the open request
 * for one — so a third-party renderer for `text/html` stands in its place, which
 * is what Data Wrangler does today and what this does now.
 *
 * Standing in for it carries an obligation: **every HTML output in the notebook
 * comes through here**, not only the frames. So `renderHtml` below draws the
 * output the way the renderer it replaced would have, and the buttons are
 * appended beside that rather than instead of it. If PolarSense makes a chart
 * render differently, this file is the bug.
 *
 * No kernel is involved and none is needed. The button says which output was
 * clicked and nothing else; the extension host answers which frame that is from
 * the cell's own source, and reads the file behind it — so the buttons work in a
 * notebook that has never been run, on a `.ipynb` opened cold.
 */

/** The slice of the renderer API this uses. Ten lines beats a dependency. */
interface OutputItem {
  readonly id: string;
  readonly mime: string;
  text(): string;
}

interface RendererContext {
  readonly postMessage?: (message: unknown) => void;
  readonly onDidReceiveMessage?: (listener: (message: unknown) => void) => void;
}

interface Renderer {
  renderOutputItem(item: OutputItem, element: HTMLElement): void;
  disposeOutputItem(id?: string): void;
}

const ACTIONS: [command: string, label: string, title: string][] = [
  [
    'showDetails',
    'Details',
    'Every column of the file behind this frame, with the dtype and statistics ' +
    'its footer records. Reads no rows.'
  ],
  [
    'showData',
    'Data',
    'The rows of the file behind this frame, a hundred at a time. Reads rows ' +
    'from the file — not the frame, so filters in the cell are not applied.'
  ]
];

export function activate(context: RendererContext): Renderer {
  /** The bars on screen, so a setting change reaches the outputs already drawn. */
  const bars = new Map<string, HTMLElement>();
  let enabled = true;
  let asked = false;

  context.onDidReceiveMessage?.((message) => {
    const config = message as { type?: string; buttons?: boolean } | undefined;
    if (config?.type !== 'config' || typeof config.buttons !== 'boolean') return;
    enabled = config.buttons;
    for (const bar of bars.values()) bar.hidden = !enabled;
  });

  return {
    renderOutputItem(item, element) {
      const html = item.text();
      element.replaceChildren();

      const output = document.createElement('div');
      element.appendChild(output);
      renderHtml(html, output);

      // No messaging means a button that would do nothing when clicked, and an
      // output that is not a frame has nothing to show. Either way: no bar.
      const post = context.postMessage;
      if (!post || !looksLikeFrame(html)) return;

      const bar = buttons(post, item.id);
      bar.hidden = !enabled;
      bars.set(item.id, bar);
      element.appendChild(bar);

      if (!asked) {
        asked = true;
        post({ type: 'ready' });
      }
    },

    disposeOutputItem(id) {
      if (id === undefined) bars.clear();
      else bars.delete(id);
    }
  };
}

/**
 * The output, drawn the way the built-in renderer draws it.
 *
 * `innerHTML` never runs a `<script>`, and the renderer this replaces re-creates
 * them so that outputs which draw themselves — plotly, bokeh, anything that
 * ships a script with its markup — still work. Skipping that would make this
 * quietly worse than what it stands in for, on outputs that have nothing to do
 * with PolarSense. The scripts are the ones the notebook's own outputs carry and
 * they ran here before this extension existed.
 *
 * This function is the seam. When VS Code lands a supported way to extend the
 * built-in HTML renderer, it is the only thing in this file that changes.
 */
function renderHtml(html: string, into: HTMLElement): void {
  into.innerHTML = trusted(html);
  for (const script of Array.from(into.querySelectorAll('script'))) {
    const fresh = document.createElement('script');
    for (const attribute of Array.from(script.attributes)) {
      fresh.setAttribute(attribute.name, attribute.value);
    }
    fresh.textContent = script.textContent;
    script.replaceWith(fresh);
  }
}

/**
 * Trusted Types, where the webview enforces them. The policy is a pass-through:
 * this is output the editor was already going to render, and sanitising it here
 * would change what the notebook shows.
 */
const policy = (() => {
  const types = (window as { trustedTypes?: TrustedTypeFactory }).trustedTypes;
  try {
    return types?.createPolicy('polarsense-output', { createHTML: (value: string) => value });
  } catch {
    // A policy of that name already exists, or the page forbids new ones.
    return undefined;
  }
})();

interface TrustedTypeFactory {
  createPolicy(
    name: string,
    rules: { createHTML(value: string): string }
  ): { createHTML(value: string): string };
}

function trusted(html: string): string {
  return (policy?.createHTML(html) ?? html) as string;
}

function buttons(post: (message: unknown) => void, outputId: string): HTMLElement {
  ensureStyle();
  const bar = document.createElement('div');
  bar.className = 'polarsense-bar';

  const label = document.createElement('span');
  label.className = 'polarsense-label';
  label.textContent = 'PolarSense';
  bar.appendChild(label);

  for (const [command, text, title] of ACTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = title;
    button.addEventListener('click', () => post({ command, outputId }));
    bar.appendChild(button);
  }
  return bar;
}

/**
 * One stylesheet for the document, not one per output: a notebook can hold
 * hundreds of frames and they all get the same bar.
 */
let styled = false;

function ensureStyle(): void {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = `
.polarsense-bar{
  display:inline-flex;align-items:stretch;margin:.4rem 0 .5rem;
  font-family:var(--vscode-font-family);
  border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));
  border-radius:5px;overflow:hidden;
  background:var(--vscode-editorWidget-background);
  opacity:.72;transition:opacity .1s ease;
}
.polarsense-bar:hover,.polarsense-bar:focus-within{opacity:1}
.polarsense-label{
  display:flex;align-items:center;padding:0 .55rem;
  font-size:.66rem;text-transform:uppercase;letter-spacing:.09em;
  color:var(--vscode-descriptionForeground);
  border-right:1px solid var(--vscode-widget-border,var(--vscode-panel-border));
}
.polarsense-bar button{
  font-family:inherit;font-size:.78rem;line-height:1;
  color:var(--vscode-foreground);background:transparent;
  border:none;padding:.32rem .6rem;cursor:pointer;
}
.polarsense-bar button+button{
  border-left:1px solid var(--vscode-widget-border,var(--vscode-panel-border));
}
.polarsense-bar button:hover{background:var(--vscode-toolbar-hoverBackground)}
.polarsense-bar button:active{background:var(--vscode-toolbar-activeBackground)}
.polarsense-bar button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.polarsense-bar[hidden]{display:none}
`;
  document.head.appendChild(style);
}
