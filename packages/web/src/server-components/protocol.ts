import { ServerComponentError } from "./error.ts"
import type { ComponentKey, ComponentValue } from "./types.ts"
import { componentValue } from "./value.ts"

export const COMPONENT_HEADER = "x-nifra-component"
export const COMPONENT_MEDIA_TYPE = "application/vnd.nifra.component-v1"
export const COMPONENT_PROTOCOL = 1
export const COMPONENT_LIMITS = Object.freeze({
  headerBytes: 2048,
  encodedHeaderBytes: 2732,
  inputBytes: 1024,
  propsBytes: 65536,
  outputBytes: 1048576,
  documentBytes: 4194304,
  frameBytes: 262144,
  depth: 16,
  instances: 128,
  requestLoads: 8,
  activeLoads: 64,
  queuedLoads: 128,
  executionMs: 10000,
  idleMs: 5000,
  operationMs: 15000,
})

export interface ComponentRequest {
  readonly v: 1
  readonly build: string
  readonly reference: string
  readonly key: ComponentKey
  readonly parent: string | null
  readonly generation: number
  readonly routeEpoch: number
  readonly authEpoch: number
  readonly input: ComponentValue
}

const fields = [
  "v",
  "build",
  "reference",
  "key",
  "parent",
  "generation",
  "routeEpoch",
  "authEpoch",
  "input",
]
const token = /^[A-Za-z0-9_-]{1,128}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export function componentKey(value: unknown): value is ComponentKey {
  return (
    (typeof value === "string" &&
      encoder.encode(value).length > 0 &&
      encoder.encode(value).length <= 128) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  )
}

export function parseComponentRequest(value: unknown): ComponentRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ServerComponentError("component_protocol", 400)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Object shape is checked before field inspection; every field is validated before a request is returned.
  const object = value as Record<string, unknown>
  if (
    Object.keys(object).length !== fields.length ||
    fields.some((name) => !Object.hasOwn(object, name)) ||
    object.v !== 1 ||
    typeof object.build !== "string" ||
    !token.test(object.build) ||
    typeof object.reference !== "string" ||
    !token.test(object.reference) ||
    !componentKey(object.key) ||
    (object.parent !== null && (typeof object.parent !== "string" || !token.test(object.parent)))
  ) {
    throw new ServerComponentError("component_protocol", 400)
  }
  const counter = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new ServerComponentError("component_protocol", 400)
    return value
  }
  const input = componentValue(object.input, COMPONENT_LIMITS.inputBytes)
  return {
    v: 1,
    build: object.build,
    reference: object.reference,
    key: object.key,
    parent: object.parent,
    generation: counter(object.generation),
    routeEpoch: counter(object.routeEpoch),
    authEpoch: counter(object.authEpoch),
    input,
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/={1,2}$/, "")
}

export function componentRequestHeader(value: ComponentRequest): string {
  const request = parseComponentRequest(value)
  const bytes = encoder.encode(JSON.stringify(request))
  if (bytes.length > COMPONENT_LIMITS.headerBytes)
    throw new ServerComponentError("component_limit", 431)
  return base64url(bytes)
}

export function readComponentRequest(request: Request): ComponentRequest | undefined {
  const encoded = request.headers.get(COMPONENT_HEADER)
  if (encoded === null) return undefined
  if (
    request.method !== "GET" ||
    request.headers.has("x-nifra-data") ||
    request.headers.has("x-nifra-retain") ||
    request.headers.has("x-nifra-revalidate") ||
    request.headers.has("x-nifra-from")
  )
    throw new ServerComponentError("component_protocol", 400)
  if (encoded.length > COMPONENT_LIMITS.encodedHeaderBytes)
    throw new ServerComponentError("component_limit", 431)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1)
    throw new ServerComponentError("component_protocol", 400)
  const origin = new URL(request.url).origin
  if (
    request.headers.get("sec-fetch-site") !== "same-origin" ||
    (request.headers.has("origin") && request.headers.get("origin") !== origin)
  ) {
    throw new ServerComponentError("component_denied", 403)
  }
  let decoded: unknown
  try {
    const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    if (bytes.length > COMPONENT_LIMITS.headerBytes)
      throw new ServerComponentError("component_limit", 431)
    if (base64url(bytes) !== encoded) throw new ServerComponentError("component_protocol", 400)
    decoded = JSON.parse(decoder.decode(bytes))
  } catch (error) {
    if (error instanceof ServerComponentError) throw error
    throw new ServerComponentError("component_protocol", 400)
  }
  return parseComponentRequest(decoded)
}

export const COMPONENT_RESPONSE_HEADERS = Object.freeze({
  "content-type": COMPONENT_MEDIA_TYPE,
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  vary: "x-nifra-component, x-nifra-data",
})

export function componentFailure(error: unknown): Response {
  const failure =
    error instanceof ServerComponentError ? error : new ServerComponentError("component_failed")
  return Response.json(
    { v: 1, error: failure.code },
    {
      status: failure.status === 499 ? 409 : failure.status,
      headers: { ...COMPONENT_RESPONSE_HEADERS, "content-type": "application/json" },
    },
  )
}
