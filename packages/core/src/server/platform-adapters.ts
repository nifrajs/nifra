/**
 * Thin adapters for platforms that do not expose a Web `fetch` handler directly.
 *
 * The app remains a Web-standard handler. These adapters only translate the platform event envelope;
 * they do not own identity, persistence, retries, or platform credentials.
 */

import type { Platform } from "./context.ts"
import type { MaybePromise } from "./server.ts"

export interface FetchApp<Env = unknown> {
  fetch(request: Request, platform?: Platform<Env>): MaybePromise<Response>
}

export type VercelHandler = (request: Request) => MaybePromise<Response>

/** Adapt a Web-standard app to a Vercel Edge Function default export. */
export function toVercelHandler<Env = unknown>(app: FetchApp<Env>): VercelHandler {
  return (request) => app.fetch(request)
}

type HeaderValue = string | readonly string[] | undefined
type HeaderRecord = Readonly<Record<string, HeaderValue>>

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function headersFromRecords(
  single: HeaderRecord | undefined,
  multi: HeaderRecord | undefined,
): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(single ?? {})) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  for (const [name, value] of Object.entries(multi ?? {})) {
    headers.delete(name)
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  return headers
}

function absoluteUrl(
  raw: string | undefined,
  path: string,
  query: string | undefined,
  headers: Headers,
): string {
  if (raw !== undefined) {
    try {
      return new URL(raw).toString()
    } catch {
      // Fall through to the structured event fields.
    }
  }
  const host = headers.get("host") ?? "nifra.invalid"
  const url = new URL(path || "/", `https://${host}`)
  if (query !== undefined && query !== "") url.search = query.startsWith("?") ? query : `?${query}`
  return url.toString()
}

function requestBody(
  body: string | null | undefined,
  encoded: boolean | undefined,
): string | Uint8Array<ArrayBuffer> | undefined {
  if (body === undefined || body === null) return undefined
  return encoded === true ? decodeBase64(body) : body
}

/**
 * Every `set-cookie` on a response, as separate values.
 *
 * `Headers.forEach` and `Headers.get` collapse repeated `set-cookie` into one comma-joined string,
 * and a cookie's `Expires` attribute contains a comma - so the joined form cannot be split back
 * apart, and a plain record keyed by header name keeps only one cookie regardless. Both platforms
 * have a dedicated channel for this; `getSetCookie` is how we fill it.
 */
function setCookiesOf(headers: Headers): readonly string[] {
  const getSetCookie = (headers as { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getSetCookie === "function") return getSetCookie.call(headers)
  const single = headers.get("set-cookie")
  return single === null ? [] : [single]
}

async function platformResponse(
  response: Response,
  /** `cookies` is API Gateway v2's dedicated array; v1 and Netlify carry them in multi-value headers. */
  cookieChannel: "cookies" | "multiValueHeaders",
): Promise<PlatformResponse> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") return
    headers[name] = value
  })
  const cookies = setCookiesOf(response.headers)
  return {
    statusCode: response.status,
    headers,
    ...(cookies.length === 0
      ? {}
      : cookieChannel === "cookies"
        ? { cookies }
        : { multiValueHeaders: { "set-cookie": cookies } }),
    body: encodeBase64(bytes),
    isBase64Encoded: true,
  }
}

export interface NetlifyEvent {
  readonly httpMethod: string
  readonly path: string
  readonly rawUrl?: string
  readonly rawQuery?: string
  readonly headers?: HeaderRecord
  readonly multiValueHeaders?: HeaderRecord
  readonly body?: string | null
  readonly isBase64Encoded?: boolean
  readonly cookies?: readonly string[]
}

export interface PlatformResponse {
  readonly statusCode: number
  /** Single-valued headers. `set-cookie` never appears here - see the two fields below. */
  readonly headers: Readonly<Record<string, string>>
  /**
   * Repeated headers, currently only `set-cookie`. Netlify Functions and API Gateway REST (v1) read
   * this; omitted when the response sets no cookies.
   */
  readonly multiValueHeaders?: Readonly<Record<string, readonly string[]>>
  /** API Gateway HTTP API (v2) takes cookies here rather than in a header. Omitted when there are none. */
  readonly cookies?: readonly string[]
  readonly body: string
  readonly isBase64Encoded: true
}

export type NetlifyHandler = (event: NetlifyEvent) => Promise<PlatformResponse>

/** Adapt a Web-standard app to a Netlify Functions event handler. */
export function toNetlifyHandler<Env = unknown>(app: FetchApp<Env>): NetlifyHandler {
  return async (event) => {
    const headers = headersFromRecords(event.headers, event.multiValueHeaders)
    if (event.cookies !== undefined && !headers.has("cookie")) {
      headers.set("cookie", event.cookies.join("; "))
    }
    const init: RequestInit = {
      method: event.httpMethod,
      headers,
    }
    const body = requestBody(event.body, event.isBase64Encoded)
    if (body !== undefined) init.body = body
    const request = new Request(
      absoluteUrl(event.rawUrl, event.path, event.rawQuery, headers),
      init,
    )
    return platformResponse(await app.fetch(request), "multiValueHeaders")
  }
}

export interface LambdaV2Event {
  readonly version?: "2.0"
  readonly rawPath?: string
  readonly rawQueryString?: string
  readonly headers?: HeaderRecord
  readonly cookies?: readonly string[]
  readonly body?: string | null
  readonly isBase64Encoded?: boolean
  readonly requestContext?: {
    readonly domainName?: string
    readonly http?: { readonly method: string; readonly path?: string }
  }
}

export interface LambdaV1Event {
  readonly httpMethod: string
  readonly path: string
  readonly headers?: HeaderRecord
  readonly multiValueHeaders?: HeaderRecord
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>>
  readonly multiValueQueryStringParameters?: Readonly<Record<string, readonly string[] | undefined>>
  readonly body?: string | null
  readonly isBase64Encoded?: boolean
  readonly requestContext?: { readonly domainName?: string }
}

export type LambdaEvent = LambdaV2Event | LambdaV1Event
export type LambdaResponse = PlatformResponse
export type LambdaHandler = (event: LambdaEvent, context?: unknown) => Promise<LambdaResponse>

function isLambdaV2(event: LambdaEvent): event is LambdaV2Event {
  return "version" in event || "rawPath" in event || "rawQueryString" in event
}

function queryFromLambdaV1(event: LambdaV1Event): string {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(event.multiValueQueryStringParameters ?? {})) {
    for (const item of value ?? []) params.append(name, item)
  }
  for (const [name, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (value !== undefined && !params.has(name)) params.set(name, value)
  }
  return params.toString()
}

/** Adapt API Gateway HTTP API (v2) and REST API (v1) events to a Web-standard app. */
export function toLambdaHandler<Env = unknown>(app: FetchApp<Env>): LambdaHandler {
  return async (event) => {
    const v2 = isLambdaV2(event)
    const headers = headersFromRecords(event.headers, v2 ? undefined : event.multiValueHeaders)
    let path: string
    let query: string
    let method: string
    let rawUrl: string | undefined
    if (v2) {
      method = event.requestContext?.http?.method ?? "GET"
      path = event.rawPath ?? event.requestContext?.http?.path ?? "/"
      query = event.rawQueryString ?? ""
      const domain = event.requestContext?.domainName
      rawUrl =
        domain === undefined ? undefined : `https://${domain}${path}${query ? `?${query}` : ""}`
      if (event.cookies !== undefined && !headers.has("cookie"))
        headers.set("cookie", event.cookies.join("; "))
    } else {
      method = event.httpMethod
      path = event.path
      query = queryFromLambdaV1(event)
      const domain = event.requestContext?.domainName
      rawUrl =
        domain === undefined ? undefined : `https://${domain}${path}${query ? `?${query}` : ""}`
    }
    const body = event.body
    const init: RequestInit = {
      method,
      headers,
    }
    const requestBodyValue = requestBody(body, event.isBase64Encoded)
    if (requestBodyValue !== undefined) init.body = requestBodyValue
    const request = new Request(absoluteUrl(rawUrl, path, query, headers), init)
    return platformResponse(await app.fetch(request), v2 ? "cookies" : "multiValueHeaders")
  }
}
