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
// registered `onResponseBody` hook needs it (the flag below), so hook-less apps pay nothing.
const RESPONSE_BODY = Symbol.for("nifra.response.body")
let tagResponseBodies = false

/** Called once when the first `onResponseBody` hook registers (process-wide; the tag is inert). */
export function enableResponseBodyTagging(): void {
  tagResponseBodies = true
}

/** The framework-serialized bytes riding a tagged Response, or `undefined` for raw/streamed ones. */
export function taggedResponseBody(response: Response): string | Uint8Array | undefined {
  return (response as { [RESPONSE_BODY]?: string | Uint8Array })[RESPONSE_BODY]
}

function tagged(response: Response, body: string): Response {
  if (tagResponseBodies) {
    Object.defineProperty(response, RESPONSE_BODY, { value: body })
  }
  return response
}

/** Fused-lane respond when `c.set` is untouched. Bun 1.3's native `Response.json` now beats the
 * older hand-inlined stringify + Response construction on this lane while preserving the exact
 * body/content-type contract; keep the generic fallback for non-JSON values. */
export function fusedRespondNoSet(result: unknown): Response {
  if (
    result !== undefined &&
    !(result instanceof Response) &&
    typeof result === "object" &&
    result !== null &&
    !isResponseResult(result)
  ) {
    if (tagResponseBodies) {
      const body = JSON.stringify(result) as string | undefined
      if (body !== undefined) return tagged(new Response(body, JSON_INIT_200), body)
    }
    return Response.json(result)
  }
  return toResponse(result as HandlerResult, EMPTY_RESPONSE_CONTROLS)
}

/** Fused-lane respond with a context: read `c.set` once; untouched (the common case) -> the fast
 * JSON respond; touched -> the generic `toResponse` with those controls (statuses, headers, cookies). */
export function fusedRespond(result: unknown, ctx: RawContext): Response {
  const set = ctx[CONTEXT_SET]()
  if (set === undefined) return fusedRespondNoSet(result)
  return toResponse(result as HandlerResult, set)
}

export function toResponse(result: HandlerResult, set: CtxSet): Response {
  if (isResponseResult(result)) {
    return appendCookiesToResponse(result.toResponse(), set)
  }
  if (result instanceof Response) {
    return appendCookiesToResponse(result, set)
  }
  const headers = headersInit(set)
  const status = set.status ?? (result === undefined ? 204 : 200)
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
      )
    }
  }
  const init: ResponseInit = headers === undefined ? { status } : { status, headers }
  if (result === undefined) return new Response(null, init)
  if (tagResponseBodies) {
    const body = JSON.stringify(result) as string | undefined
    if (body !== undefined) {
      return tagged(new Response(body, { status, headers: withJsonContentType(headers) }), body)
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
  return "content-type" in headers
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
