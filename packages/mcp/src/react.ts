/**
 * `reactWidget` - author an MCP Apps (`ui://`) widget from a React component instead of hand-written HTML.
 *
 * The component is bundled for the browser (via `Bun.build`) together with a bootstrap that mounts it and
 * re-renders on every `structuredContent` the host pushes - `mcpApp.onData(data => root.render(<C {...data}/>))`.
 * So a widget author writes a normal nifra/React component that takes the tool's structured data as props;
 * the bridge wiring and bundling are handled here. Client-rendered (the widget shell is the resource the
 * host fetches once; data arrives over the bridge), which matches how a host renders MCP App widgets.
 *
 * `react` + `react-dom` resolve from the CONSUMER's `node_modules` at bundle time - they are NOT a
 * dependency of `@nifrajs/mcp`. This entry is Bun-only (it calls `Bun.build`); import it from
 * `@nifrajs/mcp/react`, not the package root, so the core stays runtime-agnostic and dependency-free.
 *
 * A server that runs on Node or Deno bundles ahead of time instead: {@link bundleReactWidget} returns
 * the widget body at build time, the package ships it as a file, and the server passes that file's text
 * to `defineMcpWidget({ html })` at run time - no `Bun.build`, no React install where it runs.
 */
import { randomBytes } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { defineMcpWidget, type McpWidget } from "./widget.ts"

export interface BundleReactWidgetOptions {
  /** Absolute path to a `.tsx`/`.jsx` module whose DEFAULT export is a React component. It receives the
   * tool's `structuredContent` as props. */
  readonly component: string
  /** Minify the client bundle (default true). */
  readonly minify?: boolean
}

export interface ReactWidgetOptions extends BundleReactWidgetOptions {
  /** The widget's `ui://` resource URI, e.g. `ui://orders/table`. */
  readonly uri: string
  readonly name: string
  readonly description?: string
  readonly title?: string
  /** Extra `<head>` content (styles, fonts). The bridge + component bundle are injected for you. */
  readonly head?: string
}

/** Bundle `component` + a bootstrap into a self-contained browser IIFE that renders on pushed data. */
async function bundleComponent(componentPath: string, minify: boolean): Promise<string> {
  const dir = dirname(componentPath)
  // The bootstrap must sit next to the component so its relative import - and `react`/`react-dom`
  // resolution up the tree - work against the consumer's node_modules. Unique name; removed in `finally`.
  const bootPath = join(dir, `.nifra-mcp-widget.${randomBytes(6).toString("hex")}.tsx`)
  const boot = `import { createElement } from "react"
import { createRoot } from "react-dom/client"
import Component from ${JSON.stringify(`./${basename(componentPath)}`)}
const el = document.getElementById("root")
if (el) {
  const root = createRoot(el)
  const draw = (data) => root.render(createElement(Component, data || {}))
  const api = window.mcpApp
  if (api) api.onData(draw); else draw({})
}`
  try {
    await writeFile(bootPath, boot)
    const out = await Bun.build({
      entrypoints: [bootPath],
      target: "browser",
      format: "iife",
      minify,
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    })
    if (!out.success) {
      throw new Error(
        `reactWidget: failed to bundle ${componentPath}:\n${out.logs.map((l) => String(l)).join("\n")}`,
      )
    }
    const output = out.outputs[0]
    if (output === undefined) throw new Error(`reactWidget: empty bundle for ${componentPath}`)
    return await output.text()
  } finally {
    await rm(bootPath, { force: true })
  }
}

/**
 * Bundle a React component into a widget body: the mount point and one inline script that renders the
 * component on every pushed `structuredContent`. Pass it to `defineMcpWidget({ html })`, which adds the
 * document shell and the bridge. Run it at build time and ship the result as a file when the server
 * itself does not run on Bun.
 */
export async function bundleReactWidget(opts: BundleReactWidgetOptions): Promise<string> {
  const bundle = await bundleComponent(opts.component, opts.minify ?? true)
  // Escape any `</script` the bundle may contain (inside string/regex literals) so it can't terminate
  // this inline <script> early - `<\/script` is equivalent JS but invisible to the HTML parser.
  const safe = bundle.replace(/<\/(script)/gi, "<\\/$1")
  // `safe` is a Bun-generated JavaScript bundle with every HTML script end-tag escaped before it is
  // placed in this inline script. The widget test asserts the generated document remains intact.
  return `<div id="root"></div>\n<script>${safe}</script>` // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
}

/** Build a {@link McpWidget} from a React component. Async - it bundles the component at definition time
 * (a one-time cost at server start); pass the result to `createMcpServer({ widgets })` / a tool's `widget`. */
export async function reactWidget(opts: ReactWidgetOptions): Promise<McpWidget> {
  const html = await bundleReactWidget(opts)
  return defineMcpWidget({
    uri: opts.uri,
    name: opts.name,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.head !== undefined ? { head: opts.head } : {}),
    html,
  })
}
