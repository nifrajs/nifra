/**
 * `@nifrajs/image/server` - nifra's **self-hosted** image resize endpoint. `createImageHandler` returns a
 * `(req: Request) => Promise<Response>` you mount at the path your {@link selfHostedLoader} points to
 * (e.g. `"/_image"`). It validates the query, safely resolves the source (local file under a `root`, or
 * a remote URL on an `allowedOrigins` allowlist - both **fail-closed** against SSRF), then decodes →
 * resizes (never upscaling) → re-encodes via a pluggable {@link ImageBackend}. The default
 * {@link bunImageBackend} uses `Bun.Image` (libjpeg-turbo / libspng / libwebp, off-thread).
 *
 * This subpath touches the filesystem and a native codec, so it is for **Node/Bun servers**, not the
 * edge. On Workers / Vercel-Edge / Deno-Deploy there is no native codec - use the CDN `cloudflareLoader`
 * from `@nifrajs/image` instead. The dependency-free core (`@nifrajs/image`) never imports this module.
 */

import { constants as FS } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { resolve as resolvePath, sep } from "node:path"

import {
  bunImageBackend,
  type ImageBackend,
  ImageProcessingError,
  type OutputFormat,
} from "./backend.ts"

import { verifyImageParams } from "./sign.ts"

// The codec seam + every official backend (Bun/sharp/WASM) live in the edge-safe `./backend.ts`
// (`@nifrajs/image/backends`), importable WITHOUT this module's `node:fs` - so a WASM backend can ship to
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
  /** Max source pixels (w×h) before rejecting (413) - decompression-bomb guard. Default 40 MP. */
  readonly maxSourcePixels?: number
  /** Hard cap on the requested width; larger `?w` is clamped down. Default 3840. */
  readonly maxWidth?: number
  /** Max concurrent transforms (codec work is CPU/memory-heavy). Excess requests queue. Default 4. */
  readonly concurrency?: number
  /**
   * Max requests reading a source at once - the admission width. Sized above `concurrency` on purpose:
   * a remote source is network-bound, and holding a codec slot across a 10s fetch would let a handful
   * of slow origins idle the CPU lane out entirely. Default `concurrency * 2`.
   *
   * This is also the memory bound: at most this many source buffers exist at once, so the ceiling is
   * `sourceConcurrency * maxSourceBytes` (default 8 x 20 MiB = 160 MiB) plus the codec's own working
   * set. Lower it, or `maxSourceBytes`, on a small instance.
   */
  readonly sourceConcurrency?: number
  /** Maximum queued image requests beyond the admission width. Default `concurrency * 16`. */
  readonly maxQueue?: number
  /** `Cache-Control: public, max-age=<n>` seconds. Default 1 hour. */
  readonly cacheMaxAge?: number
  /** Add `immutable` to Cache-Control. Off by default: enable only when every source URL changes with
   * its content, otherwise browsers are allowed to retain a changed image until the full max-age. */
  readonly immutable?: boolean
  /** Quality used when `?q` is absent. Default 75. */
  readonly defaultQuality?: number
  /** Remote-fetch timeout (ms). Default 10 000. */
  readonly fetchTimeoutMs?: number
  /** `fetch` implementation for remote sources (injectable for custom timeouts/proxy and for tests).
   * Default: the global `fetch`. */
  readonly fetch?: typeof fetch
  /** Require **signed URLs**: every request must carry a valid `&s=` HMAC over `(src, w, q[, exp])` or
   * it's rejected with `403`. Use the SAME `secret` as your `selfHostedLoader`/`signImageUrl`. This
   * locks the endpoint to URLs your app minted - the defense against resize-bombing. */
  readonly signing?: { readonly secret: string }
}

const MAX_SRC_LEN = 2048

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`image: ${name} must be a non-negative safe integer`)
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`image: ${name} must be a finite positive safe integer`)
  }
}

interface ResolvedConfig {
  readonly backend: ImageBackend
  readonly root: string | null
  readonly allowedOrigins: ReadonlySet<string>
  readonly maxSourceBytes: number
  readonly maxSourcePixels: number
  readonly maxWidth: number
  readonly cacheMaxAge: number
  readonly immutable: boolean
  readonly defaultQuality: number
  readonly fetchTimeoutMs: number
  readonly fetchImpl: typeof fetch
  readonly signing: { readonly secret: string } | null
  /** Admission: held for the whole request, so it bounds how many source buffers are alive at once. */
  readonly admit: Semaphore
  /** The codec lane: taken only around probe + transform, never across a source read. */
  readonly codec: Semaphore
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
  const maxSourceBytes = options.maxSourceBytes ?? 20 * 1024 * 1024
  const maxSourcePixels = options.maxSourcePixels ?? 40_000_000
  const concurrency = options.concurrency ?? 4
  const sourceConcurrency = options.sourceConcurrency ?? concurrency * 2
  const maxQueue = options.maxQueue ?? concurrency * 16
  const maxWidth = options.maxWidth ?? 3840
  const cacheMaxAge = options.cacheMaxAge ?? 3_600
  const defaultQuality = options.defaultQuality ?? 75
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 10_000
  const immutable = options.immutable ?? false
  assertNonNegativeSafeInteger(maxSourceBytes, "maxSourceBytes")
  assertPositiveSafeInteger(maxSourcePixels, "maxSourcePixels")
  assertPositiveSafeInteger(concurrency, "concurrency")
  assertPositiveSafeInteger(sourceConcurrency, "sourceConcurrency")
  assertNonNegativeSafeInteger(maxQueue, "maxQueue")
  assertPositiveSafeInteger(maxWidth, "maxWidth")
  assertNonNegativeSafeInteger(cacheMaxAge, "cacheMaxAge")
  assertPositiveSafeInteger(fetchTimeoutMs, "fetchTimeoutMs")
  if (!Number.isSafeInteger(defaultQuality) || defaultQuality < 1 || defaultQuality > 100) {
    throw new RangeError("image: defaultQuality must be a safe integer from 1 to 100")
  }
  if (typeof immutable !== "boolean") throw new TypeError("image: immutable must be a boolean")
  if (sourceConcurrency < concurrency) {
    // Otherwise the codec lane can never fill, and `concurrency` silently means something narrower.
    throw new RangeError("image: sourceConcurrency must be >= concurrency")
  }
  return {
    backend: options.backend ?? bunImageBackend(),
    root: options.root !== undefined ? resolvePath(options.root) : null,
    allowedOrigins: new Set(options.allowedOrigins ?? []),
    maxSourceBytes,
    maxSourcePixels,
    maxWidth,
    cacheMaxAge,
    immutable,
    defaultQuality,
    fetchTimeoutMs,
    fetchImpl: options.fetch ?? globalThis.fetch,
    signing: options.signing ?? null,
    admit: createSemaphore(sourceConcurrency, maxQueue),
    // Every admitted request must be able to wait for a codec slot, so the waiter bound is the
    // admission width - this semaphore rejects nothing; `admit` is the only place a 503 comes from.
    codec: createSemaphore(concurrency, sourceConcurrency),
  }
}

async function handle(req: Request, cfg: ResolvedConfig): Promise<Response> {
  // 1. Method - only safe reads. (HEAD shares the GET path; the body is stripped at the end.)
  if (req.method !== "GET" && req.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed", { Allow: "GET, HEAD" })
  }

  // 2. Validate the query at the trust boundary (strict scalar parsing - no Number() coercion).
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
  //     `&s=` HMAC over the raw (src, w, q[, exp]) - exactly what the loader/`signImageUrl` signed -
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

  // 3/4. Admission precedes source reads so queued requests do not retain large buffers. It is a
  //      separate, wider lane from the codec one below: a remote source is a network wait, and letting
  //      it hold a codec slot would let `concurrency` slow origins stall every transform on the box.
  const admission = await cfg.admit.acquire(req.signal)
  if (admission === "full") return errorResponse(503, "image_queue_full")
  if (admission === "aborted") return errorResponse(499, "request_cancelled")
  try {
    const source = await readSource(src, cfg, req.signal)
    if (!source.ok) return errorResponse(source.status, source.code)
    // The bytes are in hand; now queue for CPU. This semaphore never refuses - its waiter bound is the
    // admission width - so a wait here is a wait, not a 503.
    const codecAdmission = await cfg.codec.acquire(req.signal)
    if (codecAdmission === "full") return errorResponse(503, "image_queue_full")
    if (codecAdmission === "aborted") return errorResponse(499, "request_cancelled")
    let out: Awaited<ReturnType<ImageBackend["transform"]>>
    try {
      // Probe → enforce the portable pixel cap → clamp to intrinsic (never upscale) → transform.
      const probe = await cfg.backend.probe(source.bytes)
      if (probe.width * probe.height > cfg.maxSourcePixels) {
        return errorResponse(413, "source_too_large")
      }
      if (req.signal.aborted) return errorResponse(499, "request_cancelled")
      const targetWidth = Math.max(1, Math.min(width, probe.width))
      const format = negotiateFormat(probe.format, wantsWebp)
      out = await cfg.backend.transform({
        bytes: source.bytes,
        width: targetWidth,
        quality,
        format,
      })
      if (req.signal.aborted) return errorResponse(499, "request_cancelled")
    } finally {
      cfg.codec.release()
    }

    // A strong validator describes the bytes actually emitted. Hashing request parameters here would
    // falsely return 304 when a mutable local/remote source changes at the same URL.
    const etag = `"${await sha256(out.bytes)}"`
    const headers = new Headers({
      "Cache-Control": `public, max-age=${cfg.cacheMaxAge}${cfg.immutable ? ", immutable" : ""}`,
      ETag: etag,
      Vary: "Accept",
    })
    headers.set("Content-Type", out.contentType)
    headers.set("Content-Length", String(out.bytes.byteLength))
    headers.set("X-Content-Type-Options", "nosniff") // never let a client sniff the re-encoded bytes
    if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers })
    // HEAD: identical headers, no body.
    if (req.method === "HEAD") return new Response(null, { status: 200, headers })
    return new Response(out.bytes, { status: 200, headers })
  } catch (err) {
    if (err instanceof ImageProcessingError) {
      if (err.kind === "too_large") return errorResponse(413, "source_too_large")
      return errorResponse(415, "unsupported_media_type") // decode | unsupported
    }
    // Unexpected - never leak internals to the client.
    return errorResponse(500, "internal_error")
  } finally {
    cfg.admit.release()
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
async function readSource(
  src: string,
  cfg: ResolvedConfig,
  signal: AbortSignal,
): Promise<SourceResult> {
  if (signal.aborted) return { ok: false, status: 499, code: "request_cancelled" }
  const asUrl = tryParseUrl(src)
  if (asUrl !== null) {
    if (asUrl.protocol !== "http:" && asUrl.protocol !== "https:") {
      return { ok: false, status: 400, code: "unsupported_scheme" }
    }
    if (!cfg.allowedOrigins.has(asUrl.origin)) {
      return { ok: false, status: 403, code: "source_not_allowed" }
    }
    return fetchRemote(asUrl, cfg, signal)
  }
  return readLocal(src, cfg, signal)
}

async function fetchRemote(
  url: URL,
  cfg: ResolvedConfig,
  requestSignal: AbortSignal,
): Promise<SourceResult> {
  const controller = new AbortController()
  let timedOut = false
  const onRequestAbort = (): void => controller.abort(requestSignal.reason)
  requestSignal.addEventListener("abort", onRequestAbort, { once: true })
  // Close the add/check race: a signal that aborted immediately before listener registration still
  // cancels the fetch rather than running an abandoned request to completion.
  if (requestSignal.aborted) onRequestAbort()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, cfg.fetchTimeoutMs)
  try {
    const res = await cfg.fetchImpl(url, {
      redirect: "error", // a redirect could bounce to a disallowed origin - refuse it.
      signal: controller.signal,
      headers: { Accept: "image/*" },
    })
    if (!res.ok) return { ok: false, status: 502, code: "upstream_error" }
    const bytes = await readBoundedBytes(res, cfg.maxSourceBytes)
    if (bytes === null) return { ok: false, status: 413, code: "source_too_large" }
    if (requestSignal.aborted) return { ok: false, status: 499, code: "request_cancelled" }
    return { ok: true, bytes }
  } catch (err) {
    const name = err instanceof Error ? err.name : ""
    if (requestSignal.aborted) return { ok: false, status: 499, code: "request_cancelled" }
    return timedOut || name === "TimeoutError"
      ? { ok: false, status: 504, code: "upstream_timeout" }
      : { ok: false, status: 502, code: "upstream_unreachable" }
  } finally {
    clearTimeout(timer)
    requestSignal.removeEventListener("abort", onRequestAbort)
  }
}

async function readLocal(
  src: string,
  cfg: ResolvedConfig,
  signal: AbortSignal,
): Promise<SourceResult> {
  if (cfg.root === null) return { ok: false, status: 403, code: "source_not_allowed" }
  // `src` is already percent-decoded by URLSearchParams - do NOT decode again (double-decode bypass).
  if (src.includes("\0")) return { ok: false, status: 400, code: "invalid_src" }
  // Strip leading slashes so a site-absolute ("/hero.jpg") or protocol-relative ("//evil") path is
  // treated as root-relative; `resolve` then collapses any "../" and the containment check rejects it.
  const rel = src.replace(/^\/+/, "")
  const resolved = resolvePath(cfg.root, rel)
  if (resolved !== cfg.root && !resolved.startsWith(cfg.root + sep)) {
    return { ok: false, status: 403, code: "source_not_allowed" }
  }
  // Resolve containment, then open that verified name exactly once. Reopening `resolved` after these
  // checks would let a writable source tree swap a symlink between verification and read.
  let real: string
  try {
    real = await realpath(resolved)
    const realRoot = await realpath(cfg.root)
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      return { ok: false, status: 403, code: "source_not_allowed" }
    }
  } catch {
    return { ok: false, status: 404, code: "source_not_found" }
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(real, FS.O_RDONLY | FS.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile()) return { ok: false, status: 404, code: "source_not_found" }
    if (info.size > cfg.maxSourceBytes) {
      return { ok: false, status: 413, code: "source_too_large" }
    }
    // Read no more than the descriptor size that passed the cap. If the file grows concurrently, the
    // appended bytes are deliberately ignored; if it shrinks, return only the bytes actually read.
    const bytes = new Uint8Array(info.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      if (signal.aborted) return { ok: false, status: 499, code: "request_cancelled" }
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (signal.aborted) return { ok: false, status: 499, code: "request_cancelled" }
    return { ok: true, bytes: offset === bytes.byteLength ? bytes : bytes.slice(0, offset) }
  } catch {
    return { ok: false, status: 404, code: "source_not_found" }
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The response has already been decided; descriptor-close failure cannot change it.
      }
    }
  }
}

/** Read a response body, aborting (→ null) once `limit` bytes are exceeded. Trusts neither the
 * `Content-Length` header (checked as a fast reject) nor an absent one - the running total is the gate. */
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

/** Collision-resistant content digest for a strong representation validator. */
async function sha256(bytes: Uint8Array): Promise<string> {
  // Copy so a backend-owned mutable buffer cannot change while Web Crypto is reading it.
  const stable = new Uint8Array(bytes.byteLength)
  stable.set(bytes)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", stable))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
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
 * Async counting semaphore with direct slot hand-off - a released slot is passed straight to the next
 * waiter (the active count is never transiently decremented), so a concurrent `acquire()` can't slip
 * past the limit in the microtask gap. Bounds concurrent codec work.
 */
interface Semaphore {
  acquire(signal?: AbortSignal): Promise<"acquired" | "full" | "aborted">
  release(): void
}

function createSemaphore(max: number, maxWaiters: number): Semaphore {
  let active = 0
  interface Waiter {
    readonly grant: () => void
  }
  const waiters: Waiter[] = []
  const acquire = async (signal?: AbortSignal): Promise<"acquired" | "full" | "aborted"> => {
    if (signal?.aborted === true) return "aborted"
    if (active < max) {
      active++
      return "acquired"
    }
    if (waiters.length >= maxWaiters) return "full"
    return new Promise((resolve) => {
      const cleanup = (): void => signal?.removeEventListener("abort", onAbort)
      const waiter: Waiter = {
        grant: () => {
          cleanup()
          resolve("acquired") // slot handed over by release(); active remains unchanged
        },
      }
      const onAbort = (): void => {
        const index = waiters.indexOf(waiter)
        if (index === -1) return // already granted synchronously by release()
        waiters.splice(index, 1)
        cleanup()
        resolve("aborted")
      }
      waiters.push(waiter)
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted === true) onAbort() // close the add/check race
    })
  }
  const release = (): void => {
    const next = waiters.shift()
    if (next !== undefined) {
      next.grant() // hand the slot to the waiter without touching `active`
    } else {
      active--
    }
  }
  return { acquire, release }
}
