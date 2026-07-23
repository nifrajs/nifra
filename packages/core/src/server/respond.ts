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
      return new Response(
        body,
        status === 200 ? JSON_INIT_200 : { status, headers: JSON_CT_HEADERS },
      )
    }
  }
  const init: ResponseInit = headers === undefined ? { status } : { status, headers }
  return result === undefined ? new Response(null, init) : Response.json(result, init)
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
