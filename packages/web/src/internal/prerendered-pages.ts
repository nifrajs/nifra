import { pathnameOf } from "@nifrajs/core/server"
import { isDraftEnabled } from "../draft.ts"
import { DATA_HEADER } from "../router.ts"

/**
 * Pages a self-hosted build prerendered, which `createWebApp` answers from their file instead of
 * rendering them. The file is served from inside the app, after `use` middleware, so a gate in front of
 * the pages still runs.
 */
export interface PrerenderedPages {
  /** Each servable path, spelled as a request URL spells it, mapped to the document headers its
   * build-time render answered with (a prerender entry's `serveHeaders`). */
  readonly pages: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** The page's HTML, or `undefined` to render it on demand instead. */
  read(pathname: string): Promise<string | undefined>
}

// The document headers a render produces from the route alone, so the build-time value is the value
// every request would get. Loader headers are left out: a prerendered page is a static file.
const REPLAYED = [
  "content-language",
  "content-security-policy",
  "content-security-policy-report-only",
]
// Vary values a file still answers correctly: compression is negotiated by the host, and a data request
// never reaches the file.
const STATIC_VARY = new Set(["accept-encoding", DATA_HEADER])

/**
 * The headers a self-hosted server replays with a prerendered page, or `undefined` when its build-time
 * render was specific to that request and the page must keep rendering on demand: it set a cookie, was
 * marked private or no-store (a nonce page always is), or varied on a request header.
 */
export function prerenderedDocumentHeaders(
  status: number,
  headers: Headers,
): Record<string, string> | undefined {
  if (status !== 200 || headers.has("set-cookie")) return undefined
  const cacheControl = (headers.get("cache-control") ?? "").toLowerCase()
  if (/\b(?:private|no-store)\b/.test(cacheControl)) return undefined
  for (const name of (headers.get("vary") ?? "").split(",")) {
    const trimmed = name.trim().toLowerCase()
    if (trimmed !== "" && !STATIC_VARY.has(trimmed)) return undefined
  }
  const replayed: Record<string, string> = {}
  for (const name of REPLAYED) {
    const value = headers.get(name)
    if (value !== null) replayed[name] = value
  }
  return replayed
}

/**
 * Wrap a page route's GET handler so a plain document request for a prerendered path is answered from
 * its file. Anything a file cannot answer the way a render would renders on demand: a query string, a
 * navigation data or component request, a draft-mode visitor, or a file the reader cannot return.
 */
export function servePrerenderedPages(
  prerendered: PrerenderedPages,
  draftSecret: string | undefined,
): <C extends { readonly req: Request }, R>(
  render: (c: C) => Promise<R>,
) => (c: C) => Promise<R | Response> {
  const pages = new Map(Object.entries(prerendered.pages))
  return (render) => async (c) => {
    const req = c.req
    const pathname = pathnameOf(req.url)
    const headers = pages.get(pathname)
    if (
      headers === undefined ||
      req.url.includes("?") ||
      req.headers.has(DATA_HEADER) ||
      req.headers.has("x-nifra-component") ||
      (draftSecret !== undefined && (await isDraftEnabled(req, draftSecret)))
    ) {
      return render(c)
    }
    const html = await prerendered.read(pathname)
    if (html === undefined) return render(c)
    if (req.method !== "HEAD") {
      return new Response(html, {
        headers: { ...headers, "content-type": "text/html; charset=utf-8" },
      })
    }
    return new Response(null, {
      headers: {
        ...headers,
        "content-type": "text/html; charset=utf-8",
        "content-length": String(new TextEncoder().encode(html).byteLength),
      },
    })
  }
}
