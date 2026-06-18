/**
 * Bounded request-body reading — the single source of truth for nifra's body-size cap. A lying or
 * absent `Content-Length` can't force us to buffer an oversized payload: a declared length over the
 * cap is rejected *before* buffering, and a chunked / length-less body is aborted mid-stream once the
 * running byte count exceeds the cap. Shared by the server's schema path, `c.boundedBody`, and
 * `verifyWebhook` so they all enforce the same guarantee.
 */

interface BodySource {
  readonly headers: Pick<Headers, "get">
  readonly body: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
}

export function parseContentLength(value: string): number | undefined {
  if (value.length === 0) return undefined
  let length = 0
  for (let i = 0; i < value.length; i++) {
    const digit = value.charCodeAt(i) - 48
    if (digit < 0 || digit > 9) return undefined
    length = length * 10 + digit
    if (length > Number.MAX_SAFE_INTEGER) return Number.POSITIVE_INFINITY
  }
  return length
}

/** The shared streaming byte-cap loop: read until done, or cancel + 413 once over `maxBytes`.
 * A single-chunk body (the common case for small chunked payloads) returns the runtime's own
 * chunk directly — no chunk array, no copy-merge. */
export async function drainCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 413 }> {
  const reader = body.getReader()
  let first: Uint8Array | undefined
  let rest: Uint8Array[] | undefined
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return { ok: false, status: 413 }
    }
    if (first === undefined) {
      first = value
    } else {
      rest ??= []
      rest.push(value)
    }
  }
  if (rest === undefined) return { ok: true, bytes: first ?? new Uint8Array(0) }
  const merged = new Uint8Array(total)
  merged.set(first as Uint8Array, 0)
  let offset = (first as Uint8Array).byteLength
  for (const chunk of rest) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes: merged }
}

/**
 * Read a request body as **bytes**, capped at `maxBytes`. Rejects a `Content-Length` over the cap
 * before buffering (`413`) and a malformed `Content-Length` (`400`); a chunked / length-less body
 * falls through to the streaming byte-cap guard. Fast path: a non-chunked request with a
 * `Content-Length` within the cap is read via native `arrayBuffer()` (framing-bounded by the runtime's
 * HTTP server), skipping the manual stream loop.
 */
export async function readBoundedBytes(
  req: BodySource,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 413 }> {
  const declared = req.headers.get("content-length")
  if (declared !== null) {
    // A present Content-Length must be a non-negative integer (HTTP grammar: `1*DIGIT`). A non-numeric
    // / negative / fractional value is malformed → 400, rather than falling through to the streaming
    // guard (an UPPER-bound cap only, so a lying SMALLER length would otherwise be read in full).
    const length = parseContentLength(declared)
    if (length === undefined) return { ok: false, status: 400 }
    if (length > maxBytes) return { ok: false, status: 413 }
    const chunked = req.headers.get("transfer-encoding") !== null
    if (!chunked) return { ok: true, bytes: new Uint8Array(await req.arrayBuffer()) }
  }
  const body = req.body
  if (body === null) return { ok: true, bytes: new Uint8Array(0) }
  return drainCapped(body, maxBytes)
}
