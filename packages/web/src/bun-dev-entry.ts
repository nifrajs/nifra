/**
 * `@nifrajs/web/bun-dev-entry` — discovering the client-entry URL Bun's dev server assigns.
 *
 * ## Why this file exists at all
 *
 * Bun's dev server bundles an HTML route and rewrites its `<script src="./entry.tsx">` into a
 * content-hashed URL under `/_bun/client/`. That rewrite is the whole point: the hash changes per build,
 * so the URL cannot be predicted or hard-coded.
 *
 * nifra needs that URL, because nifra renders the document. Bun never sees the page it would inject the
 * script into - `createWebApp` builds the HTML from the route's own output and needs `clientEntry` to
 * emit `<script type="module" src=…>` and the matching `modulepreload`. So the two halves have to meet:
 * Bun knows the URL, nifra needs it, and there is no supported API connecting them. Verified against Bun
 * 1.3.14: the HTML import evaluates to `{}` with no keys, the `Bun.serve` instance exposes nothing
 * asset-related, and `/_bun/manifest`, `/_bun/client/manifest.json` and `/_bun/assets` all 404.
 *
 * The only route is to ask the dev server for a page it *did* bundle and read the URL back out of it.
 *
 * ## Why it is a module instead of four lines inline
 *
 * A regex over another tool's output is a dependency on an unspecified format, and that is true whether
 * it lives here or inline in the dev server. What changes is the blast radius. Isolated here it is one
 * function with one caller, covered by tests that pin the exact tag shape Bun emits today - so a Bun
 * upgrade that changes the format fails a test with a diff of the markup instead of producing a dev
 * server that boots fine and serves pages whose scripts 404. And if Bun ever exposes a real accessor,
 * this is the only body that changes.
 *
 * Detection is layered so a cosmetic change degrades instead of breaking: the `data-bun-dev-server-script`
 * attribute is the precise signal, an unambiguous single module script under `/_bun/` is the fallback,
 * and anything else is a named error that says what was searched for and what was found.
 */

/** One `<script>` tag lifted out of a served page: its raw attribute text and parsed `src`. */
interface ScriptTag {
  readonly attrs: string
  readonly src: string | undefined
}

// `<script …>` open tags. Attribute text is captured raw; `src` is parsed out of it separately so the
// two are independent of attribute ORDER (Bun emits `crossorigin src=… data-bun-dev-server-script`, but
// nothing in HTML makes that order stable).
const SCRIPT_OPEN = /<script\b([^>]*)>/gi
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i
// The attribute Bun marks its own bundled entry with. Valueless today; matched tolerantly so a future
// `data-bun-dev-server-script="1"` still hits.
const MARKER_ATTR = /\bdata-bun-dev-server-script\b/i
// Bun serves every bundled client asset under this prefix.
const BUN_CLIENT_PREFIX = "/_bun/"

/** Pull every `<script>` open tag out of an HTML document, in source order. */
function scriptTags(html: string): ScriptTag[] {
  const tags: ScriptTag[] = []
  SCRIPT_OPEN.lastIndex = 0
  for (let m = SCRIPT_OPEN.exec(html); m !== null; m = SCRIPT_OPEN.exec(html)) {
    const attrs = m[1] ?? ""
    const src = SRC_ATTR.exec(attrs)
    tags.push({ attrs, src: src?.[1] ?? src?.[2] ?? src?.[3] })
  }
  return tags
}

/** How the entry URL was found - reported so a fallback hit is visible rather than silent. */
export type DevEntryVia = "marker" | "single-bun-script"

/** A located client entry: the URL to hand nifra, its stylesheets, and which signal found it. */
export interface DevEntryMatch {
  readonly src: string
  /**
   * Stylesheet URLs Bun extracted from the entry's CSS imports.
   *
   * These are not a nicety. Bun's bundler pulls `import "./app.css"` out of the JS graph and links it
   * from the HTML *it* bundled - the throwaway probe page, which nobody ever sees. nifra renders the real
   * pages, so unless these are carried across, a Bun-pipeline dev session serves every page unstyled
   * while the production build (which reads CSS from the build manifest) is fine. That is the worst
   * possible shape for a bug: dev-only, silent, and looks like the app's own CSS is broken.
   */
  readonly styles: readonly string[]
  readonly via: DevEntryVia
}

// `<link rel="stylesheet" href="…">`. `rel` and `href` are matched independently of order, same reason
// as the script tags: attribute order in generated markup is not a contract.
const LINK_OPEN = /<link\b([^>]*)>/gi
const HREF_ATTR = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i
const REL_STYLESHEET =
  /\brel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|stylesheet)/i

/** Every stylesheet URL linked from a document, in source order. */
export function parseDevStyles(html: string): string[] {
  const hrefs: string[] = []
  LINK_OPEN.lastIndex = 0
  for (let m = LINK_OPEN.exec(html); m !== null; m = LINK_OPEN.exec(html)) {
    const attrs = m[1] ?? ""
    if (!REL_STYLESHEET.test(attrs)) continue
    const href = HREF_ATTR.exec(attrs)
    const url = href?.[1] ?? href?.[2] ?? href?.[3]
    if (url !== undefined && url !== "") hrefs.push(url)
  }
  return hrefs
}

/**
 * Find the bundled client-entry URL in a page Bun's dev server rendered. Pure - the whole format
 * dependency lives in this function, which is what makes it testable against captured real output.
 *
 * Returns `undefined` rather than throwing so the caller can attach the context a useful error needs
 * (which URL was probed, what the server returned).
 */
export function parseDevEntry(html: string): DevEntryMatch | undefined {
  const tags = scriptTags(html)
  const styles = parseDevStyles(html)
  // 1. The precise signal: Bun's own marker attribute.
  for (const tag of tags) {
    if (MARKER_ATTR.test(tag.attrs) && tag.src !== undefined && tag.src !== "") {
      return { src: tag.src, styles, via: "marker" }
    }
  }
  // 2. Fallback: exactly one script pointing into Bun's client-asset prefix. Requiring uniqueness is what
  //    keeps this a fallback and not a guess - with two candidates there is no basis for picking one, so
  //    it declines and lets the caller raise a real error.
  const bunScripts = tags.filter((t) => t.src?.startsWith(BUN_CLIENT_PREFIX))
  const only = bunScripts.length === 1 ? bunScripts[0] : undefined
  if (only?.src !== undefined) return { src: only.src, styles, via: "single-bun-script" }
  return undefined
}

/** The error thrown when Bun's dev server serves a page nothing in it can be recognised as the entry. */
export function devEntryNotFoundMessage(probeUrl: string, html: string): string {
  const scripts = scriptTags(html)
  const found =
    scripts.length === 0
      ? "the page contains no <script> tags at all"
      : `the page's script tags are: ${scripts.map((s) => `<script${s.attrs}>`).join(", ")}`
  return (
    `[nifra] could not find Bun's bundled client entry in the page served at ${probeUrl}.\n` +
    `  Looked for a <script> carrying \`data-bun-dev-server-script\`, then for a single module script ` +
    `under \`${BUN_CLIENT_PREFIX}\`; ${found}.\n` +
    `  This is how Bun's dev server labelled its bundled entry when this was written, so a Bun upgrade ` +
    `that changes the markup lands here first. Run the Bun pipeline dev server's tests to see the ` +
    `current shape, or use the Vite pipeline (\`nifra dev\`) meanwhile.`
  )
}

/** Structural slice of a running server this needs: just the port it bound. */
export interface ServedOn {
  readonly port: number
}

export interface ResolveDevEntryOptions {
  /** Path of the throwaway route serving Bun's bundled HTML (e.g. `/__nifra/entry`). */
  readonly probePath: string
  /** Injected for tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/**
 * Ask Bun's dev server for the current bundled entry URL. One loopback request against a route the app
 * never exposes.
 *
 * **The answer expires.** The URL is a content hash over the whole client graph, so editing any file it
 * reaches - a route, a component, a stylesheet - re-hashes it. Caching the startup value and injecting it
 * forever produces a spectacular failure: Bun answers a superseded chunk URL with a 104-byte
 * `location.reload()` stub under a 405, so the page reloads, gets the same dead URL from SSR, and reloads
 * again, forever. No console output survives the loop to explain it. Callers must re-resolve rather than
 * remember - see how `@nifrajs/web/dev` serves a stable URL that redirects here per request.
 */
export async function resolveDevEntry(
  server: ServedOn,
  options: ResolveDevEntryOptions,
): Promise<DevEntryMatch> {
  const doFetch = options.fetchImpl ?? fetch
  const probeUrl = `http://127.0.0.1:${server.port}${options.probePath}`
  const response = await doFetch(probeUrl)
  if (!response.ok) {
    throw new Error(
      `[nifra] Bun's dev server returned ${response.status} for the client-entry probe at ${probeUrl}. ` +
        "The generated HTML route did not build - the error above this line is Bun's.",
    )
  }
  const html = await response.text()
  const match = parseDevEntry(html)
  if (match === undefined) throw new Error(devEntryNotFoundMessage(probeUrl, html))
  return match
}
