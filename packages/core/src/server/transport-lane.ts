/** Opt-in versioned transport integration. Kept outside the server kernel's bare dependency graph. */
import type { TransportCodec, TransportCodecRegistry } from "../transport-codec.ts"
import { readBoundedBytes } from "./body.ts"
import { jsonError } from "./http.ts"
import { guardDecodedValue, type ProtoPoisoning } from "./proto-guard.ts"
import { isResponseResult, PRE_DECODED_BODY, type PreDecodedBody } from "./runtime-core.ts"
import type { AnyServer, IdentityPlugin } from "./server.ts"

interface TransportBodySource {
  readonly headers: Pick<Headers, "get">
  readonly body: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
}

export type TransportDecodeResult =
  | { readonly matched: false }
  | { readonly matched: true; readonly value: unknown }
  | { readonly matched: true; readonly response: Response }

export interface TransportRuntime {
  responseCodec(accept: string | null): TransportCodec
  decodeRequest(
    source: TransportBodySource,
    contentType: string,
    maxBytes: number,
  ): Promise<TransportDecodeResult>
}

export interface TransportCodecsOptions {
  /** Maximum encoded request bytes. Keep aligned with `server({ maxBodyBytes })`. */
  readonly maxBytes?: number
  /**
   * Prototype-poisoning policy for decoded request bodies, mirroring
   * `server({ protoPoisoning })` - this lane parses with the codec's own decoder, so the body
   * lane's guard never sees the raw text and the policy must be enforced here. Default `"reject"`:
   * a poisoned payload answers the same flat 400 as an undecodable one.
   */
  readonly protoPoisoning?: ProtoPoisoning
}

export function transportCodecs(
  registry: TransportCodecRegistry,
  options: TransportCodecsOptions = {},
): IdentityPlugin {
  const maxBytes = options.maxBytes ?? 1_000_000
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("transport maxBytes must be a non-negative safe integer")
  }
  const protoPoisoning = options.protoPoisoning ?? "reject"
  const runtime: TransportRuntime = Object.freeze({
    responseCodec(accept: string | null): TransportCodec {
      try {
        return registry.negotiate(accept)
      } catch {
        return registry.fallback
      }
    },
    async decodeRequest(
      source: TransportBodySource,
      contentType: string,
      maxBytes: number,
    ): Promise<TransportDecodeResult> {
      let codec: TransportCodec
      try {
        codec = registry.forContentType(contentType)
      } catch {
        return { matched: false }
      }
      if (codec.id === "json" && codec.version === 1 && codec.mediaType === "application/json")
        return { matched: false }
      const read = await readBoundedBytes(source, maxBytes)
      if (!read.ok) {
        return {
          matched: true,
          response: jsonError(
            read.status,
            read.status === 413 ? "payload_too_large" : "bad_request",
          ),
        }
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)
        // Same poisoning policy as the body lane, enforced on the codec's own decode - a rejected
        // payload answers exactly like an undecodable one.
        return {
          matched: true,
          value: guardDecodedValue(text, codec.decode(text), protoPoisoning),
        }
      } catch {
        return {
          matched: true,
          response: jsonError(400, "invalid_transport_payload"),
        }
      }
    },
  })
  const apply = <S extends AnyServer>(app: S): S => {
    app.onRequest(async (request) => {
      const contentType = request.headers.get("content-type") ?? ""
      let requestCodec: TransportCodec
      try {
        requestCodec = registry.forContentType(contentType)
      } catch {
        return undefined
      }
      if (
        requestCodec.id === "json" &&
        requestCodec.version === 1 &&
        requestCodec.mediaType === "application/json"
      ) {
        return undefined
      }
      const replacement = request.clone()
      const decoded = await runtime.decodeRequest(request, contentType, maxBytes)
      if (!decoded.matched) return undefined
      if ("response" in decoded) return decoded.response

      // Re-frame as a plain JSON request whose already-decoded value rides the pre-decoded stash;
      // the body lane takes the stash verbatim (this lane owns the cap and poisoning policy), so
      // the placeholder body is never parsed and codec machinery stays out of the kernel.
      const headers: Record<string, string> = {}
      replacement.headers.forEach((value, name) => {
        headers[name] = value
      })
      headers["content-type"] = "application/json"
      headers["content-length"] = "2"
      delete headers["transfer-encoding"]
      const normalized = new Request(replacement.url, {
        method: replacement.method,
        headers,
        body: "{}",
        signal: replacement.signal as never,
      })
      const stash: PreDecodedBody = { value: decoded.value }
      Object.defineProperty(normalized, PRE_DECODED_BODY, { value: stash })
      return normalized
    })
    app.afterHandle((result, context) => {
      if (result === undefined || result instanceof Response || isResponseResult(result))
        return result
      const codec = runtime.responseCodec(context.req.headers.get("accept"))
      const headers = new Headers(context.set.headers)
      headers.set("content-type", codec.mediaType)
      return new Response(codec.encode(result), {
        status: context.set.status ?? 200,
        headers,
      })
    })
    return app
  }
  return Object.assign(apply, { pluginName: "nifra:transport-codecs" }) as IdentityPlugin
}
