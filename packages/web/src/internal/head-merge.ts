/**
 * Head resolution + merging, in its own module so the CLIENT can have it without the server.
 *
 * These two are pure functions over `Meta`, but they used to live in `index.ts` - the module that also
 * carries `renderPage`, `createWebApp` and the static-file server. The generated client entry imported
 * them from `@nifrajs/web`, which under a bundler was harmless (server code tree-shakes away) and under
 * Vite's dev server was fatal: it serves each module as-is, so pulling `index.ts` into the browser graph
 * executed `public-dir.ts` and the page died on `Module "node:fs/promises" has been externalized`
 * before hydrating. Splitting them out means the client entry never names the server module at all,
 * rather than relying on a bundler to remove it afterwards.
 *
 * `index.ts` and `client.ts` both re-export from here, so the public API is unchanged in both places.
 */
import type {
  LinkDescriptor,
  Meta,
  MetaArgs,
  MetaDescriptor,
  MetaInput,
  ScriptDescriptor,
  UnsafeScriptDescriptor,
} from "../manifest.ts"

/** Resolve a route's `meta` export - a static object, or a function of the route's data/params. */
export function resolveMeta(meta: MetaInput | undefined, args: MetaArgs): Meta {
  if (meta === undefined) return {}
  return typeof meta === "function" ? meta(args) : meta
}

/**
 * Merge a layout chain's heads, outermost first: `title`/`lang`/`dir` are nearest-wins, and
 * `meta`/`link`/`script` concatenate in chain order.
 *
 * Returns a fresh object whose identity is stable per `heads` *content* only when every entry is a
 * static (by-reference) `Meta` and there is exactly one - otherwise a new object each call. That is
 * fine: `headTags`'s memo is keyed on identity, so a per-request merge simply recomputes (its
 * content can vary with loader data anyway).
 */
export function mergeHeads(heads: readonly Meta[]): Meta {
  // Single-head fast path (a route with no layout `meta`, by far the common case) - return the
  // resolved object by reference so headTags' identity-keyed memo hits across requests for static meta.
  if (heads.length === 1) return heads[0] as Meta
  let title: string | undefined
  let lang: string | undefined
  let dir: Meta["dir"]
  const meta: MetaDescriptor[] = []
  const link: LinkDescriptor[] = []
  const script: ScriptDescriptor[] = []
  const unsafeScript: UnsafeScriptDescriptor[] = []
  for (const h of heads) {
    if (h.title !== undefined) title = h.title // nearest-wins: later (more specific) overrides
    if (h.lang !== undefined) lang = h.lang // nearest-wins, like title
    if (h.dir !== undefined) dir = h.dir
    if (h.meta !== undefined) meta.push(...h.meta)
    if (h.link !== undefined) link.push(...h.link)
    if (h.script !== undefined) script.push(...h.script) // concatenated like meta/link (outermost first)
    if (h.unsafeScript !== undefined) unsafeScript.push(...h.unsafeScript)
  }
  // Build the result with only the fields that were actually contributed - an empty `meta`/`link`/
  // `script` array would otherwise be a spurious (if harmless) key. A mutable local; the cast to `Meta`
  // is sound because a key is assigned only when defined (so `exactOptionalPropertyTypes` never sees
  // `undefined`).
  const merged: {
    title?: string
    meta?: Meta["meta"]
    link?: Meta["link"]
    script?: Meta["script"]
    unsafeScript?: Meta["unsafeScript"]
    lang?: string
    dir?: Meta["dir"]
  } = {}
  if (title !== undefined) merged.title = title
  if (meta.length > 0) merged.meta = meta
  if (link.length > 0) merged.link = link
  if (script.length > 0) merged.script = script
  if (unsafeScript.length > 0) merged.unsafeScript = unsafeScript
  if (lang !== undefined) merged.lang = lang
  if (dir !== undefined) merged.dir = dir
  return merged as Meta
}
