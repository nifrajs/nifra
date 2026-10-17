/**
 * Whether a host can load what its pages reference: the check that catches a host policy (or any
 * gate in front of the static files) that serves a page but refuses its stylesheet or bundle. Such a
 * page still answers 200, so a status check passes while the browser renders it unstyled and never
 * hydrates it.
 *
 * Bun-only (HTMLRewriter, Bun.Transpiler), like the rest of `@nifrajs/web/build`.
 */

/** One request the check made. */
export interface HostReachResult {
  /** The request path, as sent. */
  readonly path: string
  /** `page` for a page the check was given, `asset` for a file a page or another file references. */
  readonly kind: "page" | "asset" | "refused"
  readonly status: number
  /** What referenced it: the page or file path. Absent for a page. */
  readonly from?: string
}

export interface HostReachReport {
  readonly host: string
  readonly ok: boolean
  readonly results: readonly HostReachResult[]
  /** The results that broke the expectation: a page or asset not answered 200, a refused path answered. */
  readonly failures: readonly HostReachResult[]
  /** `limit` stopped the walk with references left unfetched; `ok` is then `false`. */
  readonly truncated: boolean
}

export interface HostReachOptions {
  /** Sends one GET. Given the path and the Host header to send. */
  readonly fetch: (path: string, host: string) => Promise<Response>
  /** The host to address (the Host header every request carries). */
  readonly host: string
  /** Page paths that must render on `host` (concrete paths, not patterns). */
  readonly pages: readonly string[]
  /** Paths `host` must refuse with `refusedStatus`. */
  readonly refused?: readonly string[]
  /** The status a refused path answers (default `404`). */
  readonly refusedStatus?: number
  /** At most this many files are fetched, pages included (default 500). */
  readonly limit?: number
}

// The attributes that make a browser fetch a file before or while a page renders.
const LINK_RELS = new Set([
  "stylesheet",
  "modulepreload",
  "preload",
  "icon",
  "apple-touch-icon",
  "manifest",
  "mask-icon",
])

/** The URLs a document asks the browser to load: scripts, stylesheets, preloads, icons, images. */
async function documentReferences(html: string): Promise<string[]> {
  const found: string[] = []
  const rewriter = new HTMLRewriter()
    .on("script[src]", {
      element: (el) => void found.push(el.getAttribute("src") ?? ""),
    })
    .on("link[href]", {
      element: (el) => {
        const rels = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/)
        if (rels.some((rel) => LINK_RELS.has(rel))) found.push(el.getAttribute("href") ?? "")
      },
    })
    .on("img[src], source[src], video[poster]", {
      element: (el) => void found.push(el.getAttribute("src") ?? el.getAttribute("poster") ?? ""),
    })
  await rewriter.transform(new Response(html)).text()
  return found.filter((url) => url !== "")
}

/** `url(...)` references in a stylesheet, found by scanning rather than a regex over untrusted text. */
function cssReferences(css: string): string[] {
  const found: string[] = []
  let at = css.indexOf("url(")
  while (at !== -1) {
    const close = css.indexOf(")", at)
    if (close === -1) break
    const raw = css
      .slice(at + 4, close)
      .trim()
      .replace(/^["']|["']$/g, "")
    if (raw !== "" && !raw.startsWith("data:")) found.push(raw)
    at = css.indexOf("url(", close)
  }
  return found
}

const scanner = new Bun.Transpiler({ loader: "js" })

/** A script's static and dynamic import specifiers that name files (not bare packages). */
function scriptReferences(code: string): string[] {
  try {
    return scanner
      .scanImports(code)
      .map((entry) => entry.path)
      .filter((path) => path.startsWith("/") || path.startsWith("./") || path.startsWith("../"))
  } catch {
    return []
  }
}

/**
 * Render each page on `host`, then fetch every same-origin file each page references, following
 * scripts' imports and stylesheets' `url()`s, and expect 200 for all of them; then expect each
 * `refused` path to answer `refusedStatus`. Cross-origin references are skipped: they are not this
 * app's to serve.
 */
export async function checkHostReach(options: HostReachOptions): Promise<HostReachReport> {
  const { host, fetch } = options
  const limit = options.limit ?? 500
  const refusedStatus = options.refusedStatus ?? 404
  const origin = `http://${host}`
  const results: HostReachResult[] = []
  const seen = new Set<string>()
  const queue: { path: string; from: string }[] = []
  const enqueue = (reference: string, base: string): void => {
    let url: URL
    try {
      url = new URL(reference, origin + base)
    } catch {
      return
    }
    if (url.origin !== origin) return
    const path = url.pathname
    if (seen.has(path)) return
    seen.add(path)
    queue.push({ path, from: base })
  }

  for (const page of options.pages) {
    if (results.length >= limit) break
    seen.add(page)
    const response = await fetch(page, host)
    const text = await response.text()
    results.push({ path: page, kind: "page", status: response.status })
    if (response.status !== 200) continue
    for (const reference of await documentReferences(text)) enqueue(reference, page)
  }
  while (results.length < limit) {
    const next = queue.shift()
    if (next === undefined) break
    const response = await fetch(next.path, host)
    results.push({ path: next.path, kind: "asset", status: response.status, from: next.from })
    if (response.status !== 200) {
      await response.body?.cancel()
      continue
    }
    const type = response.headers.get("content-type") ?? ""
    const body = await response.text()
    const references = type.includes("css")
      ? cssReferences(body)
      : type.includes("javascript")
        ? scriptReferences(body)
        : []
    for (const reference of references) enqueue(reference, next.path)
  }
  for (const path of options.refused ?? []) {
    const response = await fetch(path, host)
    await response.body?.cancel()
    results.push({ path, kind: "refused", status: response.status })
  }
  const failures = results.filter((result) =>
    result.kind === "refused" ? result.status !== refusedStatus : result.status !== 200,
  )
  const truncated = queue.length > 0
  return { host, ok: failures.length === 0 && !truncated, results, failures, truncated }
}
