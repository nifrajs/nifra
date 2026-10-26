/** Opt-in versioned transport integration. Kept outside the server kernel's bare dependency graph. */
import {
  encodeTransportResponse,
  type TransportCodec,
  type TransportCodecRegistry,
} from "../transport-codec.ts"
import { readBoundedBytes } from "./body.ts"
import { jsonError } from "./http.ts"
import { guardDecodedValue, type ProtoPoisoning } from "./proto-guard.ts"
import { carryToCopy } from "./request-local.ts"
import { isResponseResult, PRE_DECODED_BODY, type PreDecodedBody } from "./runtime-core.ts"
import type { AnyServer, IdentityPlugin } from "./server.ts"

interface TransportBodySource {
  readonly headers: Pick<Headers, "get">
  readonly body: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
}

export type TransportDecodeResult =
  | { readonly matched: false }
  | { readonly matched: true; readonly value: unknown; readonly bytes: Uint8Array }
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
  /**
   * Maximum encoded request bytes. Default 1,000,000. Keep aligned with `server({ maxBodyBytes })`.
   *
   * The plugin decodes a codec body in an `onRequest` hook, before routing, so a route's own
   * `bodyLimit` and its `authenticate()` stages run only after the decode. This cap is the only
   * bound on that work: set it to the largest codec body any route should accept.
   */
  readonly maxBytes?: number
  /**
   * Prototype-poisoning policy for decoded request bodies, mirroring
   * `server({ protoPoisoning })` - this lane parses with the codec's own decoder, so the body
   * lane's guard never sees the raw text and the policy must be enforced here. Default `"reject"`:
   * a poisoned payload answers the same flat 400 as an undecodable one.
   */
  readonly protoPoisoning?: ProtoPoisoning
  /**
   * Whether a decoded request body may hold a `RegExp` (the rich wire codec carries them). Default
   * `false`: a client-supplied pattern is code, and one with catastrophic backtracking stalls the
   * event loop the moment anything runs it. A refused body answers the same flat 400 as an
   * undecodable one.
   */
  readonly acceptRegExp?: boolean
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
  const acceptRegExp = options.acceptRegExp === true
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
          value: guardDecodedValue(codec.decode(text), protoPoisoning, acceptRegExp),
          bytes: read.bytes,
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
      const decoded = await runtime.decodeRequest(request, contentType, maxBytes)
      if (!decoded.matched) return undefined
      if ("response" in decoded) return decoded.response

      // The decoded value rides the pre-decoded stash, which the body lane takes verbatim (this lane
      // owns the cap and poisoning policy), so codec machinery stays out of the kernel. The request
      // keeps the bytes and media type it was sent with: a route without a body schema, or a
      // signature check, reads the payload itself, not a stand-in.
      const headers = new Headers(request.headers)
      headers.set("content-length", String(decoded.bytes.byteLength))
      headers.delete("transfer-encoding")
      const normalized = new Request(request.url, {
        method: request.method,
        headers,
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: every reader behind readBoundedBytes yields an unshared buffer, which a Request body accepts.
        body: decoded.bytes as Uint8Array<ArrayBuffer>,
        signal: request.signal as never,
      })
      const stash: PreDecodedBody = {
        value: decoded.value,
        byteLength: decoded.bytes.byteLength,
        encoded: decoded.bytes,
        contentType,
      }
      Object.defineProperty(normalized, PRE_DECODED_BODY, { value: stash })
      carryToCopy(request, normalized)
      return normalized
    })
    app.afterHandle((result, context) => {
      if (result === undefined || result instanceof Response || isResponseResult(result))
        return result
      // The representation depends on `Accept`, so the response says so to every shared cache.
      return encodeTransportResponse(
        result,
        runtime.responseCodec(context.req.headers.get("accept")),
        { status: context.set.status ?? 200, headers: context.set.headers },
      )
    })
    return app
  }
  return Object.assign(apply, { pluginName: "nifra:transport-codecs" }) as IdentityPlugin
}
