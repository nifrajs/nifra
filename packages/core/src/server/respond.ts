/**
 * Response construction from a handler's return value: the header/cookie init, the fused-lane
 * responders, the fast JSON path, and cookie append. Imports only the runtime-core primitives + the
 * spine types, so the wire-response format lives in one module distinct from the request engine.
 */

import {
  CONTEXT_SET,
  EMPTY_RESPONSE_CONTROLS,
  type HandlerResult,
  isResponseResult,
} from "./runtime-core.ts"
import type { CtxSet, RawContext } from "./server.ts"

/** Build the response headers init. The common path (no `c.set`) returns `undefined` so `Response`
 * gets no `headers` at all. Cookies force a `Headers` object - multiple `Set-Cookie`s can't live in a
 * `Record<string,string>` (the 2nd would overwrite the 1st), so they're `append`ed individually. */
function headersInit(set: CtxSet): Record<string, string> | Headers | undefined {
  const cookies = set._cookies
  if (cookies === undefined || cookies.length === 0) return set._headers
  const headers = new Headers(set._headers)
  for (const cookie of cookies) headers.append("set-cookie", cookie)
  return headers
}

// Keep the fast JSON respond path byte-identical to `Response.json` without probing it at module
// scope: workerd forbids `Response.json()` during startup. A shared `Headers` is safe to reuse
// across responses: the Response constructor copies `init.headers` into its own list.
const JSON_CT_HEADERS = new Headers({
  "content-type": "application/json;charset=utf-8",
})
const JSON_INIT_200: ResponseInit = { status: 200, headers: JSON_CT_HEADERS }

// The framework-buffered-body marker shared with the Node adapter: a Response carrying it exposes
// its already-serialized bytes without draining. On the Web serving paths it exists ONLY when a
// registered body/raw hook needs it, so hook-less apps pay nothing.
const RESPONSE_BODY = Symbol.for("nifra.response.body")

function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304
}

/** Normalize handler-produced bodyless responses before response middleware sees them. */
export function normalizeBodylessResponse(response: Response): Response {
  if (!isBodylessStatus(response.status)) return response
  if (response.body === null && !response.headers.has("content-length")) return response
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

type TaggedResponseMarker = {
  readonly body: string | Uint8Array
  readonly owner?: object
}

type ResponseBodyTagOption = false | true | object | undefined

/** The framework-serialized bytes riding a tagged Response, or `undefined` for raw/streamed ones. */
export function taggedResponseBody(
  response: Response,
  owners?: ReadonlySet<object>,
): string | Uint8Array | undefined {
  const marker = (response as { [RESPONSE_BODY]?: string | Uint8Array | TaggedResponseMarker })[
    RESPONSE_BODY
  ]
  if (owners !== undefined) {
    // A Web response is framework-buffered only when this app (or an intentionally merged app) put
    // the marker on it. The legacy primitive marker remains readable by the Node bridge, but must
    // not let an arbitrary response impersonate a local framework body on the Web hook path.
    if (
      typeof marker !== "object" ||
      marker === null ||
      marker instanceof Uint8Array ||
      marker.owner === undefined ||
      !owners.has(marker.owner)
    ) {
      return undefined
    }
    return marker.body
  }
  if (typeof marker === "string" || marker instanceof Uint8Array) return marker
  return marker?.body
}

export function taggedResponseOwner(response: Response): object | undefined {
  const marker = (response as { [RESPONSE_BODY]?: string | Uint8Array | TaggedResponseMarker })[
    RESPONSE_BODY
  ]
  return typeof marker === "object" && marker !== null && "owner" in marker
    ? marker.owner
    : undefined
}

export function markTaggedResponse(
  response: Response,
  body: string | Uint8Array,
  owner?: object,
): Response {
  Object.defineProperty(response, RESPONSE_BODY, {
    value: owner === undefined ? body : ({ body, owner } satisfies TaggedResponseMarker),
  })
  return response
}

function tagged(
  response: Response,
  body: string,
  tagResponseBody: ResponseBodyTagOption,
): Response {
  return tagResponseBody === false || tagResponseBody === undefined
    ? response
    : markTaggedResponse(
        response,
        body,
        typeof tagResponseBody === "object" ? tagResponseBody : undefined,
      )
}

/** Fused-lane respond when `c.set` is untouched. Bun 1.3's native `Response.json` now beats the
 * older hand-inlined stringify + Response construction on this lane while preserving the exact
 * body/content-type contract; keep the generic fallback for non-JSON values. */
export function fusedRespondNoSet(
  result: unknown,
  tagResponseBody: ResponseBodyTagOption = false,
): Response {
  if (
    result !== undefined &&
    !(result instanceof Response) &&
    typeof result === "object" &&
    result !== null &&
    !isResponseResult(result)
  ) {
    if (tagResponseBody) {
      const body = JSON.stringify(result) as string | undefined
      if (body !== undefined)
        return tagged(new Response(body, JSON_INIT_200), body, tagResponseBody)
    }
    return Response.json(result)
  }
  return toResponse(result as HandlerResult, EMPTY_RESPONSE_CONTROLS)
}

/** Fused-lane respond with a context: read `c.set` once; untouched (the common case) -> the fast
 * JSON respond; touched -> the generic `toResponse` with those controls (statuses, headers, cookies). */
export function fusedRespond(
  result: unknown,
  ctx: RawContext,
  tagResponseBody: ResponseBodyTagOption = false,
): Response {
  const set = ctx[CONTEXT_SET]()
  if (set === undefined) return fusedRespondNoSet(result, tagResponseBody)
  return toResponse(result as HandlerResult, set, tagResponseBody)
}

export function toResponse(
  result: HandlerResult,
  set: CtxSet,
  tagResponseBody: ResponseBodyTagOption = false,
): Response {
  if (isResponseResult(result)) {
    return appendCookiesToResponse(normalizeBodylessResponse(result.toResponse()), set)
  }
  if (result instanceof Response) {
    return appendCookiesToResponse(normalizeBodylessResponse(result), set)
  }
  const headers = headersInit(set)
  const status = set.status ?? (result === undefined ? 204 : 200)
  if (status === 204 || status === 205 || status === 304) {
    return new Response(null, headers === undefined ? { status } : { status, headers })
  }
  if (headers === undefined && result !== undefined) {
    // Fast respond (profiled ~50 ns/req faster on every plain-JSON return): `JSON.stringify` + a
    // prebuilt init beats `Response.json`'s internal init handling. Output is byte-identical -
    // same body bytes, same probed content-type. `undefined` from stringify (a function/symbol
    // result) delegates to Response.json so its TypeError contract stays the single source.
    const body = JSON.stringify(result) as string | undefined
    if (body !== undefined) {
      return tagged(
        new Response(body, status === 200 ? JSON_INIT_200 : { status, headers: JSON_CT_HEADERS }),
        body,
        tagResponseBody,
      )
    }
  }
  const init: ResponseInit = headers === undefined ? { status } : { status, headers }
  if (result === undefined) return new Response(null, init)
  if (tagResponseBody) {
    const body = JSON.stringify(result) as string | undefined
    if (body !== undefined) {
      return tagged(
        new Response(body, { status, headers: withJsonContentType(headers) }),
        body,
        typeof tagResponseBody === "object" ? tagResponseBody : undefined,
      )
    }
  }
  return Response.json(result, init)
}

// Add a JSON content-type without pre-building a `Headers` instance just to check-and-set one key:
// `new Headers(record)` measured ~8us/call on V8 (Deno) for a handful of header entries - it's a
// full parse-and-validate of every entry, done here only to ask "is content-type present," when
// `new Response(body, { headers })` a few lines up already does that same ingestion once, for free,
// on whatever shape is handed to it. A plain `Record` (the common case - no cookies queued) gets a
// shallow copy; an existing `Headers` (the cookies case - freshly built by `headersInit`, not
// exposed elsewhere) is mutated in place, same as before.
function withJsonContentType(
  headers: Record<string, string> | Headers | undefined,
): Record<string, string> | Headers {
  if (headers === undefined) return JSON_CT_HEADERS
  if (headers instanceof Headers) {
    if (!headers.has("content-type")) headers.set("content-type", "application/json;charset=utf-8")
    return headers
  }
  return Object.hasOwn(headers, "content-type")
    ? headers
    : { ...headers, "content-type": "application/json;charset=utf-8" }
}

export function appendCookiesToResponse(response: Response, set: CtxSet): Response {
  // A handler may queue cookies (`c.set.cookie` - e.g. a session cookie) AND return its own Response
  // (e.g. `redirect("/")` after login). Cookies accumulate additively, so append them to the
  // returned Response - otherwise the canonical set-session-then-redirect pattern would silently drop
  // the cookie. (Other `c.set` fields stay the returned Response's own concern.)
  const cookies = set._cookies
  if (cookies !== undefined && cookies.length > 0) {
    for (const cookie of cookies) response.headers.append("set-cookie", cookie)
  }
  return response
}
