/** Opt-in versioned transport integration. Kept outside the server kernel's bare dependency graph. */
import type { TransportCodec, TransportCodecRegistry } from "../transport-codec.ts"
import { readBoundedBytes } from "./body.ts"
import { jsonError } from "./http.ts"
import { isResponseResult } from "./runtime-core.ts"
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
}

export function transportCodecs(
  registry: TransportCodecRegistry,
  options: TransportCodecsOptions = {},
): IdentityPlugin {
  const maxBytes = options.maxBytes ?? 1_000_000
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("transport maxBytes must be a non-negative safe integer")
  }
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
        return {
          matched: true,
          value: codec.decode(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)),
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

      // Keep an untouched body branch while the bounded decoder consumes the other tee branch.
      // Existing JSON validation lanes can then use their native `request.json()` fast path while
      // receiving the already-decoded rich value without importing codec machinery into the kernel.
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
      Object.defineProperty(normalized, "json", {
        value: () => Promise.resolve(decoded.value),
      })
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
