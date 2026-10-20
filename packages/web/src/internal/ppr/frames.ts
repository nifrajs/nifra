import { validateComponentHTML } from "../../server-components/html.ts"
import { serializeData } from "../render-document.ts"
import { holeInvoker } from "./runtime.ts"

/**
 * A hole name: it becomes a DOM id, an attribute value, a hashed script and part of a renderer's id
 * prefix, so it stays this narrow. No `--` and no trailing `-`: Svelte refuses an id prefix with `--`.
 */
export const HOLE_NAME: RegExp = /^(?=[a-z0-9-]{1,32}$)[a-z](?:-?[a-z0-9])*$/

/** What one hole sends: its server HTML, plus props when it hydrates. An error carries the error
 * slot's HTML only, never the thrown message (I6). */
export type HoleOutcome =
  | { readonly html: string; readonly props?: unknown; readonly error?: undefined }
  | { readonly html: string; readonly error: true }

export const assertHoleName = (name: string): void => {
  if (!HOLE_NAME.test(name)) {
    throw new TypeError(
      `[nifra/web] ppr: hole name "${name}" must match ${HOLE_NAME.source} (it becomes a DOM id and a hashed script)`,
    )
  }
}

/** Refuse hole HTML that could run script or escape its host (I12), with the policy server
 * components already enforce. Throws; the caller sends that hole's error frame instead. */
export const validateHoleHtml = (html: string): void => validateComponentHTML(html)

/**
 * JSON safe inside a `<script>` element. Script data ends only at `</script`, and only `<!--` can
 * move the tokenizer into its escaped states, so escaping `</` and `<!--` is enough; both escapes are
 * plain JSON. Escaping every `<` and `>` instead, as `serializeData` does, made a 100 KB hole's frame
 * 53% larger than its HTML; this makes it about 10% larger.
 */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replaceAll("</", "<\\/").replaceAll("<!--", "<\\u0021--")

/**
 * The bytes that fill hole `name`: an inert JSON frame and the constant invoker. No `</script>` or
 * comment opener in the HTML or props survives into the element. Throws a `RangeError` when the
 * encoded frame exceeds `maxBytes`.
 */
export function encodeHoleFrame(name: string, outcome: HoleOutcome, maxBytes: number): string {
  const body =
    outcome.error === true
      ? { v: 1, error: true, html: outcome.html }
      : outcome.props === undefined
        ? { v: 1, html: outcome.html }
        : { v: 1, html: outcome.html, props: outcome.props }
  const frame = `<script type="application/json" id="nifra-ppr:${name}">${scriptJson(body)}</script><script>${holeInvoker(name)}</script>`
  // UTF-8 needs at least one and at most three bytes per UTF-16 unit, so only a frame between the two
  // bounds is encoded to measure it.
  if (
    frame.length > maxBytes ||
    (frame.length * 3 > maxBytes && new TextEncoder().encode(frame).length > maxBytes)
  ) {
    throw new RangeError(`[nifra/web] ppr: hole "${name}" frame exceeds ${maxBytes} bytes`)
  }
  return frame
}

/** The per-response facts the runtime needs to send a cancel beacon. Inert JSON: never cached (I2). */
export const encodeRequestScript = (cancelUrl: string, token: string, holes: readonly string[]) =>
  `<script type="application/json" id="nifra-ppr-req">${serializeData({ cancel: cancelUrl, token, holes })}</script>`

/**
 * Put each hole's fallback HTML into its empty host in a rendered shell, once per shell build. Every
 * declared hole must have exactly one host and that host must be empty (I5): the adapter renders
 * it opaque, so anything inside would be framework output the fill would destroy.
 */
export function injectHoleFallbacks(shell: string, fallbacks: ReadonlyMap<string, string>): string {
  const inserts: Array<{ at: number; html: string }> = []
  for (const [name, html] of fallbacks) {
    const marker = `data-nifra-hole="${name}"`
    const first = shell.indexOf(marker)
    if (first === -1)
      throw new TypeError(`[nifra/web] ppr: hole "${name}" has no host in the shell`)
    if (shell.indexOf(marker, first + marker.length) !== -1) {
      throw new TypeError(`[nifra/web] ppr: hole "${name}" has more than one host in the shell`)
    }
    const close = shell.indexOf(">", first + marker.length)
    if (close === -1 || !shell.startsWith("</", close + 1)) {
      throw new TypeError(`[nifra/web] ppr: hole "${name}"'s host must render empty`)
    }
    inserts.push({ at: close + 1, html })
  }
  inserts.sort((a, b) => a.at - b.at)
  let out = ""
  let from = 0
  for (const insert of inserts) {
    out += shell.slice(from, insert.at) + insert.html
    from = insert.at
  }
  return out + shell.slice(from)
}
