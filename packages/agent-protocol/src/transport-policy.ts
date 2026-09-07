/**
 * Protocol-neutral byte limits for HTTP adapters.
 *
 * MCP's HTTP server and the Agent App browser transport have different wire protocols, but both need
 * the same fail-closed rules when reading an untrusted stream. Keeping this small policy here avoids
 * coupling either adapter to the other while making the limit and cancellation semantics identical.
 */

export const MAX_TRANSPORT_BYTES = 64 * 1024 * 1024

export interface TransportByteLimitOptions {
  readonly minimum?: number
  readonly maximum?: number
  readonly label?: string
}

export function assertTransportByteLimit(
  value: number,
  options: TransportByteLimitOptions = {},
): void {
  const minimum = options.minimum ?? 0
  const maximum = options.maximum ?? MAX_TRANSPORT_BYTES
  if (
    !Number.isSafeInteger(value) ||
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum < 0 ||
    maximum < minimum ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${options.label ?? "transport byte limit"} must be between ${minimum} and ${maximum}`,
    )
  }
}

/** Parse a decimal Content-Length without allowing malformed or unsafe values to pass as a size. */
export function parseTransportContentLength(value: string | null): number | undefined {
  if (value === null || value.length === 0) return undefined
  let length = 0
  for (let index = 0; index < value.length; index++) {
    const digit = value.charCodeAt(index) - 48
    if (digit < 0 || digit > 9) return undefined
    length = length * 10 + digit
    if (!Number.isSafeInteger(length)) return Number.POSITIVE_INFINITY
  }
  return length
}

export type BoundedTransportRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "too-large" | "read-error"; readonly error?: unknown }

/** Read a Web stream under one byte cap, canceling the source as soon as the cap is exceeded. */
export async function readBoundedTransportBytes(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<BoundedTransportRead> {
  assertTransportByteLimit(maxBytes)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined || value.byteLength > maxBytes - total) {
        try {
          await reader.cancel()
        } catch {
          // Preserve the bounded-read result if the source has already closed.
        }
        return { ok: false, reason: "too-large" }
      }
      total += value.byteLength
      chunks.push(value)
    }
  } catch (error) {
    try {
      await reader.cancel()
    } catch {
      // Preserve the original stream error classification.
    }
    return { ok: false, reason: "read-error", error }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes }
}
