/**
 * `@nifrajs/image/server` — nifra's **self-hosted** image resize endpoint. `createImageHandler` returns a
 * `(req: Request) => Promise<Response>` you mount at the path your {@link selfHostedLoader} points to
 * (e.g. `"/_image"`). It validates the query, safely resolves the source (local file under a `root`, or
 * a remote URL on an `allowedOrigins` allowlist — both **fail-closed** against SSRF), then decodes →
 * resizes (never upscaling) → re-encodes via a pluggable {@link ImageBackend}. The default
 * {@link bunImageBackend} uses `Bun.Image` (libjpeg-turbo / libspng / libwebp, off-thread).
 *
 * This subpath touches the filesystem and a native codec, so it is for **Node/Bun servers**, not the
 * edge. On Workers / Vercel-Edge / Deno-Deploy there is no native codec — use the CDN `cloudflareLoader`
 * from `@nifrajs/image` instead. The dependency-free core (`@nifrajs/image`) never imports this module.
 */

import { readFile, realpath, stat } from "node:fs/promises"
import { resolve as resolvePath, sep } from "node:path"

import {
  bunImageBackend,
  type ImageBackend,
  ImageProcessingError,
  type OutputFormat,
} from "./backend.ts"

import { verifyImageParams } from "./sign.ts"

// The codec seam + every official backend (Bun/sharp/WASM) live in the edge-safe `./backend.ts`
// (`@nifrajs/image/backends`), importable WITHOUT this module's `node:fs` — so a WASM backend can ship to
// the edge. Re-export them so `@nifrajs/image/server` stays the single import for Node servers.
export * from "./backend.ts"

export interface ImageHandlerOptions {
  /** Codec backend. Default: {@link bunImageBackend} (requires the Bun runtime). */
  readonly backend?: ImageBackend
  /** Absolute directory that local (path) sources resolve under. Path-traversal- and symlink-guarded.
   * Omit to **disable local sources** (every path source → 403). */
  readonly root?: string
  /** Exact origins (`https://cdn.example`) allowed for remote sources. Omitted/empty ⇒ **no remote
   * sources** (fail-closed against SSRF). Only `http:`/`https:` URLs are ever considered. */
  readonly allowedOrigins?: readonly string[]
  /** Max bytes read from a source before rejecting (413). Default 20 MiB. */
  readonly maxSourceBytes?: number
  /** Max source pixels (w×h) before rejecting (413) — decompression-bomb guard. Default 40 MP. */
  readonly maxSourcePixels?: number
  /** Hard cap on the requested width; larger `?w` is clamped down. Default 3840. */
  readonly maxWidth?: number
  /** Max concurrent transforms (codec work is CPU/memory-heavy). Excess requests queue. Default 4. */
  readonly concurrency?: number
  /** `Cache-Control: public, max-age=<n>, immutable` seconds. Default 1 year. */
  readonly cacheMaxAge?: number
  /** Quality used when `?q` is absent. Default 75. */
  readonly defaultQuality?: number
  /** Remote-fetch timeout (ms). Default 10 000. */
  readonly fetchTimeoutMs?: number
  /** `fetch` implementation for remote sources (injectable for custom timeouts/proxy and for tests).
   * Default: the global `fetch`. */
  readonly fetch?: typeof fetch
  /** Require **signed URLs**: every request must carry a valid `&s=` HMAC over `(src, w, q[, exp])` or
   * it's rejected with `403`. Use the SAME `secret` as your `selfHostedLoader`/`signImageUrl`. This
   * locks the endpoint to URLs your app minted — the defense against resize-bombing. */
  readonly signing?: { readonly secret: string }
}

const MAX_SRC_LEN = 2048

interface ResolvedConfig {
  readonly backend: ImageBackend
  readonly root: string | null
  readonly allowedOrigins: ReadonlySet<string>
  readonly maxSourceBytes: number
  readonly maxSourcePixels: number
  readonly maxWidth: number
  readonly cacheMaxAge: number
  readonly defaultQuality: number
  readonly fetchTimeoutMs: number
  readonly fetchImpl: typeof fetch
  readonly signing: { readonly secret: string } | null
  readonly acquire: () => Promise<void>
  readonly release: () => void
}

/**
 * Build the resize request handler. Mount its return value at the `selfHostedLoader` endpoint:
 *
 * ```ts
 * const image = createImageHandler({ root: "./public", allowedOrigins: ["https://cdn.example"] })
 * // inside your router: if (url.pathname === "/_image") return image(req)
 * ```
 */
export function createImageHandler(
  options: ImageHandlerOptions = {},
): (req: Request) => Promise<Response> {
  const cfg = resolveConfig(options)
  return (req: Request) => handle(req, cfg)
}

function resolveConfig(options: ImageHandlerOptions): ResolvedConfig {
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const sem = createSemaphore(concurrency)
  return {
    backend: options.backend ?? bunImageBackend(),
    root: options.root !== undefined ? resolvePath(options.root) : null,
    allowedOrigins: new Set(options.allowedOrigins ?? []),
    maxSourceBytes: options.maxSourceBytes ?? 20 * 1024 * 1024,
    maxSourcePixels: options.maxSourcePixels ?? 40_000_000,
    maxWidth: options.maxWidth ?? 3840,
    cacheMaxAge: options.cacheMaxAge ?? 31_536_000,
    defaultQuality: options.defaultQuality ?? 75,
    fetchTimeoutMs: options.fetchTimeoutMs ?? 10_000,
    fetchImpl: options.fetch ?? globalThis.fetch,
    signing: options.signing ?? null,
    acquire: sem.acquire,
    release: sem.release,
  }
}

async function handle(req: Request, cfg: ResolvedConfig): Promise<Response> {
  // 1. Method — only safe reads. (HEAD shares the GET path; the body is stripped at the end.)
  if (req.method !== "GET" && req.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed", { Allow: "GET, HEAD" })
  }

  // 2. Validate the query at the trust boundary (strict scalar parsing — no Number() coercion).
  const url = new URL(req.url)
  const src = url.searchParams.get("src")
  if (src === null || src.length === 0 || src.length > MAX_SRC_LEN) {
    return errorResponse(400, "invalid_src")
  }
  const requestedWidth = parsePositiveInt(url.searchParams.get("w"))
  if (requestedWidth === null) return errorResponse(400, "invalid_width")
  const qParam = url.searchParams.get("q")
  let quality = cfg.defaultQuality
  if (qParam !== null) {
    const q = parsePositiveInt(qParam)
    if (q === null) return errorResponse(400, "invalid_quality")
    quality = Math.min(100, q)
  }
  const width = Math.min(cfg.maxWidth, requestedWidth)
  const wantsWebp = (req.headers.get("accept") ?? "").includes("image/webp")

  // 2b. Signed-URL enforcement (when configured): reject any request we didn't mint. Verifies the
  //     `&s=` HMAC over the raw (src, w, q[, exp]) — exactly what the loader/`signImageUrl` signed —
  //     and the expiry. Done before the ETag/fetch so unsigned/forged requests cost nothing.
  if (cfg.signing !== null) {
    const sig = url.searchParams.get("s")
    const ok =
      sig !== null &&
      verifyImageParams(
        cfg.signing.secret,
        {
          src,
          w: url.searchParams.get("w") ?? "",
          q: qParam ?? undefined,
          exp: url.searchParams.get("exp") ?? undefined,
        },
        sig,
        Math.floor(Date.now() / 1000),
      )
    if (!ok) return errorResponse(403, "invalid_signature")
  }

  // 3. Strong validator from the request-deterministic inputs, computed BEFORE any fetch/decode so a
  //    conditional request short-circuits all expensive work. The clamped width is a pure function of
  //    (src, requestedWidth), so (src, requestedWidth, quality, wantsWebp) fully keys the response.
  const etag = `"${fnv1a(`${src}|${requestedWidth}|${quality}|${wantsWebp ? 1 : 0}`)}"`
  const cacheHeaders: Record<string, string> = {
    "Cache-Control": `public, max-age=${cfg.cacheMaxAge}, immutable`,
    ETag: etag,
    Vary: "Accept",
  }
  if (ifNoneMatch(req, etag)) {
    return new Response(null, { status: 304, headers: cacheHeaders })
  }

  // 4. Resolve + read the source under the SSRF policy (fail-closed: unknown source kind → 403/400).
  const source = await readSource(src, cfg)
  if (!source.ok) return errorResponse(source.status, source.code)

  // 5. Probe → enforce the portable pixel cap → clamp to intrinsic (never upscale) → transform.
  //    The codec work is bounded by the concurrency semaphore.
  await cfg.acquire()
  try {
    const probe = await cfg.backend.probe(source.bytes)
    if (probe.width * probe.height > cfg.maxSourcePixels) {
      return errorResponse(413, "source_too_large")
    }
    const targetWidth = Math.max(1, Math.min(width, probe.width))
    const format = negotiateFormat(probe.format, wantsWebp)
    const out = await cfg.backend.transform({
      bytes: source.bytes,
      width: targetWidth,
      quality,
      format,
    })

    const headers = new Headers(cacheHeaders)
    headers.set("Content-Type", out.contentType)
    headers.set("Content-Length", String(out.bytes.byteLength))
    headers.set("X-Content-Type-Options", "nosniff") // never let a client sniff the re-encoded bytes
    // HEAD: identical headers, no body.
    if (req.method === "HEAD") return new Response(null, { status: 200, headers })
    return new Response(out.bytes, { status: 200, headers })
  } catch (err) {
    if (err instanceof ImageProcessingError) {
      if (err.kind === "too_large") return errorResponse(413, "source_too_large")
      return errorResponse(415, "unsupported_media_type") // decode | unsupported
    }
    // Unexpected — never leak internals to the client.
    return errorResponse(500, "internal_error")
  } finally {
    cfg.release()
  }
}

type SourceResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly status: number; readonly code: string }

/**
 * Resolve `src` to bytes under the SSRF policy. A value that parses as an absolute URL is "remote" and
 * must be `http(s)` **and** on the `allowedOrigins` allowlist; anything else is a local path resolved
 * under `root` with traversal + symlink containment checks. Both branches fail closed.
 */
async function readSource(src: string, cfg: ResolvedConfig): Promise<SourceResult> {
  const asUrl = tryParseUrl(src)
  if (asUrl !== null) {
    if (asUrl.protocol !== "http:" && asUrl.protocol !== "https:") {
      return { ok: false, status: 400, code: "unsupported_scheme" }
    }
    if (!cfg.allowedOrigins.has(asUrl.origin)) {
      return { ok: false, status: 403, code: "source_not_allowed" }
    }
    return fetchRemote(asUrl, cfg)
  }
  return readLocal(src, cfg)
}

async function fetchRemote(url: URL, cfg: ResolvedConfig): Promise<SourceResult> {
  let res: Response
  try {
    res = await cfg.fetchImpl(url, {
      redirect: "error", // a redirect could bounce to a disallowed origin — refuse it.
      signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
      headers: { Accept: "image/*" },
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ""
    return name === "TimeoutError"
      ? { ok: false, status: 504, code: "upstream_timeout" }
      : { ok: false, status: 502, code: "upstream_unreachable" }
  }
  if (!res.ok) return { ok: false, status: 502, code: "upstream_error" }
  const bytes = await readBoundedBytes(res, cfg.maxSourceBytes)
  if (bytes === null) return { ok: false, status: 413, code: "source_too_large" }
  return { ok: true, bytes }
}

async function readLocal(src: string, cfg: ResolvedConfig): Promise<SourceResult> {
  if (cfg.root === null) return { ok: false, status: 403, code: "source_not_allowed" }
  // `src` is already percent-decoded by URLSearchParams — do NOT decode again (double-decode bypass).
  if (src.includes("\0")) return { ok: false, status: 400, code: "invalid_src" }
  // Strip leading slashes so a site-absolute ("/hero.jpg") or protocol-relative ("//evil") path is
  // treated as root-relative; `resolve` then collapses any "../" and the containment check rejects it.
  const rel = src.replace(/^\/+/, "")
  const resolved = resolvePath(cfg.root, rel)
  if (resolved !== cfg.root && !resolved.startsWith(cfg.root + sep)) {
    return { ok: false, status: 403, code: "source_not_allowed" }
  }
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(resolved)
  } catch {
    return { ok: false, status: 404, code: "source_not_found" }
  }
  if (!info.isFile()) return { ok: false, status: 404, code: "source_not_found" }
  if (info.size > cfg.maxSourceBytes) return { ok: false, status: 413, code: "source_too_large" }
  // Defense-in-depth: a symlink inside root could point outside it — re-check the real path.
  try {
    const real = await realpath(resolved)
    const realRoot = await realpath(cfg.root)
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      return { ok: false, status: 403, code: "source_not_allowed" }
    }
  } catch {
    return { ok: false, status: 404, code: "source_not_found" }
  }
  return { ok: true, bytes: new Uint8Array(await readFile(resolved)) }
}

/** Read a response body, aborting (→ null) once `limit` bytes are exceeded. Trusts neither the
 * `Content-Length` header (checked as a fast reject) nor an absent one — the running total is the gate. */
async function readBoundedBytes(res: Response, limit: number): Promise<Uint8Array | null> {
  const declared = res.headers.get("content-length")
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) return null
  const reader = res.body?.getReader()
  if (reader === undefined) {
    const buf = new Uint8Array(await res.arrayBuffer())
    return buf.byteLength > limit ? null : buf
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** Prefer WebP when the client advertises it (supports alpha + best compression). Otherwise preserve a
 * JPEG source as JPEG; everything else falls back to PNG (lossless, keeps any alpha). `Vary: Accept`
 * keeps the WebP / non-WebP variants cached separately. */
function negotiateFormat(sourceFormat: string, wantsWebp: boolean): OutputFormat {
  if (wantsWebp) return "webp"
  if (sourceFormat === "jpeg" || sourceFormat === "jpg") return "jpeg"
  return "png"
}

/** Strict positive-integer parse: canonical decimal digits only (rejects signs, decimals, `1e3`, `0x`,
 * whitespace, empty). Returns null on any non-canonical input. */
function parsePositiveInt(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= 1 ? n : null
}

function tryParseUrl(src: string): URL | null {
  try {
    return new URL(src)
  } catch {
    return null
  }
}

function ifNoneMatch(req: Request, etag: string): boolean {
  const header = req.headers.get("if-none-match")
  if (header === null) return false
  if (header.trim() === "*") return true
  return header.split(",").some((t) => t.trim() === etag)
}

/** 32-bit FNV-1a over a short key string → hex. Used only as a cache validator (ETag), not security. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function errorResponse(
  status: number,
  code: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  })
}

/**
 * Async counting semaphore with direct slot hand-off — a released slot is passed straight to the next
 * waiter (the active count is never transiently decremented), so a concurrent `acquire()` can't slip
 * past the limit in the microtask gap. Bounds concurrent codec work.
 */
function createSemaphore(max: number): { acquire: () => Promise<void>; release: () => void } {
  let active = 0
  const waiters: Array<() => void> = []
  const acquire = async (): Promise<void> => {
    if (active < max) {
      active++
      return
    }
    await new Promise<void>((res) => waiters.push(res)) // slot handed over by release(), active unchanged
  }
  const release = (): void => {
    const next = waiters.shift()
    if (next !== undefined) {
      next() // hand the slot to the waiter without touching `active`
    } else {
      active--
    }
  }
  return { acquire, release }
}
