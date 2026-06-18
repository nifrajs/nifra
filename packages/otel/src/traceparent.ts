/**
 * W3C Trace Context — `traceparent` parsing/formatting + id generation. This is OpenTelemetry's
 * wire format for propagating a trace across services, so producing/forwarding it correctly is the
 * core of distributed tracing regardless of which backend ends up collecting the spans.
 *
 *   traceparent: 00-<32-hex trace-id>-<16-hex span-id>-<2-hex flags>
 *
 * Pure + dependency-free; the request plugin is a thin layer over this.
 */

/** A parsed inbound `traceparent`. */
export interface ParsedTraceparent {
  readonly traceId: string
  readonly spanId: string
  readonly sampled: boolean
}

const HEX = /^[0-9a-f]+$/
const ZERO_TRACE = "00000000000000000000000000000000"
const ZERO_SPAN = "0000000000000000"

/**
 * Parse a `traceparent` header, or `null` if it's absent/malformed/version-unknown — per the spec,
 * a bad header means "start a fresh trace", never an error. Only version `00` is accepted.
 */
export function parseTraceparent(header: string | null | undefined): ParsedTraceparent | null {
  if (!header) return null
  const parts = header.trim().split("-")
  if (parts.length !== 4) return null
  const [version, traceId, spanId, flags] = parts as [string, string, string, string]
  if (version !== "00") return null
  if (traceId.length !== 32 || !HEX.test(traceId) || traceId === ZERO_TRACE) return null
  if (spanId.length !== 16 || !HEX.test(spanId) || spanId === ZERO_SPAN) return null
  if (flags.length !== 2 || !HEX.test(flags)) return null
  // bit 0 of the flags byte = sampled
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 0x01) === 1 }
}

/** Format a `traceparent` header value (version `00`). */
export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`
}

const toHex = (bytes: Uint8Array): string => {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

/** A fresh 16-byte (32-hex) trace id. */
export function generateTraceId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)))
}

/** A fresh 8-byte (16-hex) span id. */
export function generateSpanId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(8)))
}
