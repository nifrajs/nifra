/**
 * The shared framed body parser. Kept separate from RequestContext so compact edge consumers can
 * reuse the exact trust-boundary lane without bundling the full context implementation (cookies,
 * deferred responses, and request helpers).
 */
import { drainCapped, hasTrustedBodyFraming, parseContentLength, RAW_BODY_READERS } from "./body.ts"
import { plainError } from "./http.ts"
import { guardParsedValue, type ProtoPoisoning, parseJsonGuarded } from "./proto-guard.ts"
import { isUrlEncodedForm, readBoundedForm } from "./query.ts"
import {
  headerOf,
  isResponseResult,
  PRE_DECODED_BODY,
  type PreDecodedBody,
  type ResponseResult,
  TEXT_DECODER,
} from "./runtime-core.ts"
import type { MaybePromise, RequestSource } from "./server.ts"

type JsonResultContinuation<T> = (result: unknown | ResponseResult) => T | Promise<T>
type JsonErrorContinuation<T> = (error: unknown) => T | Promise<T>

type FramedJsonSource = RequestSource & {
  readonly bytes?: () => Promise<Uint8Array>
  readonly jsonWithByteLength?: () => Promise<{
    readonly value: unknown
    readonly byteLength: number
  }>
}

const INVALID_JSON = (): ResponseResult => plainError(400, "invalid_json")

/** Read a JSON source with the declared-length precheck, delivered-byte recheck, streaming cap, and
 * prototype-poisoning guard in one lane. */
export function readBoundedJsonSource(
  req: RequestSource,
  maxBytes: number,
  protoPoisoning?: ProtoPoisoning,
): Promise<unknown | ResponseResult>
export function readBoundedJsonSource<T>(
  req: RequestSource,
  maxBytes: number,
  protoPoisoning: ProtoPoisoning,
  onResult: JsonResultContinuation<T>,
  onError: JsonErrorContinuation<T>,
): Promise<T>
export function readBoundedJsonSource<T>(
  req: RequestSource,
  maxBytes: number,
  protoPoisoning: ProtoPoisoning = "reject",
  onResult?: JsonResultContinuation<T>,
  onError?: JsonErrorContinuation<T>,
): Promise<unknown | ResponseResult | T> {
  const preDecoded = (req as { [PRE_DECODED_BODY]?: PreDecodedBody })[PRE_DECODED_BODY]
  if (preDecoded !== undefined) {
    return onResult === undefined
      ? Promise.resolve(preDecoded.value)
      : Promise.resolve(preDecoded.value).then(onResult)
  }

  const raw = ((req as { [RAW_BODY_READERS]?: RequestSource })[RAW_BODY_READERS] ??
    req) as FramedJsonSource
  const declared = headerOf(req, "content-length")
  if (declared !== null) {
    const length = parseContentLength(declared)
    if (length === undefined)
      return onResult === undefined
        ? Promise.resolve(plainError(400, "invalid_content_length"))
        : Promise.resolve(plainError(400, "invalid_content_length")).then(onResult)
    if (length > maxBytes)
      return onResult === undefined
        ? Promise.resolve(plainError(413, "payload_too_large"))
        : Promise.resolve(plainError(413, "payload_too_large")).then(onResult)

    if (hasTrustedBodyFraming(req)) {
      return raw.json().then(
        (parsed) => {
          try {
            const guarded = guardParsedValue(parsed, protoPoisoning)
            return onResult === undefined ? guarded : onResult(guarded)
          } catch {
            return onResult === undefined
              ? plainError(400, "invalid_json")
              : onResult(plainError(400, "invalid_json"))
          }
        },
        () => (onResult === undefined ? INVALID_JSON() : onResult(INVALID_JSON())),
      )
    }

    if (headerOf(req, "transfer-encoding") === null) {
      const jsonWithByteLength = raw.jsonWithByteLength
      if (jsonWithByteLength !== undefined) {
        return jsonWithByteLength.call(raw).then(
          ({ value, byteLength }) => {
            if (byteLength > length || byteLength > maxBytes) {
              return onResult === undefined
                ? plainError(413, "payload_too_large")
                : onResult(plainError(413, "payload_too_large"))
            }
            try {
              const guarded = guardParsedValue(value, protoPoisoning)
              return onResult === undefined ? guarded : onResult(guarded)
            } catch {
              return onResult === undefined
                ? plainError(400, "invalid_json")
                : onResult(plainError(400, "invalid_json"))
            }
          },
          () => (onResult === undefined ? INVALID_JSON() : onResult(INVALID_JSON())),
        )
      }

      const bytesReader = raw.bytes
      if (bytesReader !== undefined) {
        return bytesReader.call(raw).then(
          (bytes) => {
            if (bytes.byteLength > length || bytes.byteLength > maxBytes) {
              return onResult === undefined
                ? plainError(413, "payload_too_large")
                : onResult(plainError(413, "payload_too_large"))
            }
            try {
              const parsed = parseJsonGuarded(TEXT_DECODER.decode(bytes), protoPoisoning)
              return onResult === undefined ? parsed : onResult(parsed)
            } catch {
              return onResult === undefined
                ? plainError(400, "invalid_json")
                : onResult(plainError(400, "invalid_json"))
            }
          },
          () => (onResult === undefined ? INVALID_JSON() : onResult(INVALID_JSON())),
        )
      }

      return raw.arrayBuffer().then(
        (buffer) => {
          const bytes = new Uint8Array(buffer)
          if (bytes.byteLength > length || bytes.byteLength > maxBytes) {
            return onResult === undefined
              ? plainError(413, "payload_too_large")
              : onResult(plainError(413, "payload_too_large"))
          }
          try {
            const parsed = parseJsonGuarded(TEXT_DECODER.decode(bytes), protoPoisoning)
            return onResult === undefined ? parsed : onResult(parsed)
          } catch {
            return onResult === undefined
              ? plainError(400, "invalid_json")
              : onResult(plainError(400, "invalid_json"))
          }
        },
        () => (onResult === undefined ? INVALID_JSON() : onResult(INVALID_JSON())),
      )
    }
  }

  const body = raw.body
  const streamed =
    body === null
      ? Promise.resolve<unknown | ResponseResult>(plainError(400, "invalid_json"))
      : drainCapped(body, maxBytes).then((drained) => {
          if (!drained.ok) return plainError(413, "payload_too_large")
          try {
            return parseJsonGuarded(TEXT_DECODER.decode(drained.bytes), protoPoisoning)
          } catch {
            return plainError(400, "invalid_json")
          }
        })
  return onResult === undefined ? streamed : streamed.then(onResult, onError)
}

/** The shared content-type dispatcher around the JSON and urlencoded lanes. */
export function readBodyFramed<T>(
  source: RequestSource,
  maxBodyBytes: number,
  protoPoisoning: ProtoPoisoning,
  onParsed: (parsed: unknown) => MaybePromise<T>,
  wrapResponse: (response: Response | ResponseResult) => T,
  onError: (err: unknown) => MaybePromise<T>,
): Promise<T> {
  const contentType = headerOf(source, "content-type") ?? ""
  if (contentType !== "application/json" && !contentType.includes("application/json")) {
    if (isUrlEncodedForm(contentType)) {
      return readBoundedForm(source, maxBodyBytes).then(
        (form) => (isResponseResult(form) ? wrapResponse(form) : onParsed(form)),
        onError,
      ) as Promise<T>
    }
    return Promise.resolve(wrapResponse(plainError(415, "unsupported_media_type")))
  }
  try {
    return readBoundedJsonSource(
      source,
      maxBodyBytes,
      protoPoisoning,
      (parsed) => (isResponseResult(parsed) ? wrapResponse(parsed) : onParsed(parsed)),
      onError,
    )
  } catch (err) {
    return Promise.resolve(onError(err))
  }
}
