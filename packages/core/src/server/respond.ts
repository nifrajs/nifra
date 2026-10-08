/**
 * Response construction from a handler's return value: the header/cookie init, the fused-lane
 * responders, the fast JSON path, and cookie append. Imports only the runtime-core primitives + the
 * spine types, so the wire-response format lives in one module distinct from the request engine.
 */

import { NODE_BRIDGE_MARKER_KEYS } from "./bridge-markers.ts"
import { plainError } from "./http.ts"
import {
  CONTEXT_REQUEST,
  CONTEXT_SET,
  EMPTY_RESPONSE_CONTROLS,
  type HandlerResult,
  isResponseResult,
  type PlainRender,
  plainRenderHeaders,
  type ResponseResult,
} from "./runtime-core.ts"
import type { CtxSet, RawContext } from "./server.ts"
import { mergeStaticHeaderRecord, type StaticResponseHeaders } from "./static-headers.ts"

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

/** The `c.set` a plain render stands for: its status and headers, carrying over the request's queued
 * cookies so `set.cookie(...)` then an early exit still ships them. */
function plainRenderSet(plain: PlainRender, set: CtxSet): CtxSet {
  return {
    status: plain.status,
    _headers: plainRenderHeaders(plain, set),
    _cookies: set._cookies,
  } as CtxSet
}

// Keep the fast JSON respond path byte-identical to `Response.json` without probing it at module
// scope: workerd forbids `Response.json()` during startup. A shared `Headers` is safe to reuse
// across responses: the Response constructor copies `init.headers` into its own list.
const JSON_CONTENT_TYPE = "application/json;charset=utf-8"
const JSON_CT_HEADERS = new Headers({ "content-type": JSON_CONTENT_TYPE })
const JSON_INIT_200: ResponseInit = { status: 200, headers: JSON_CT_HEADERS }

/**
 * Build the per-server shapes for a validated static header record. The JSON init is prebuilt once
 * here so a static-middleware app's fused JSON lane pays a shared init read instead of a header write
 * per declared name per request - the same reuse the hook-free lane already gets from
 * {@link JSON_INIT_200}.
 */
export function buildStaticResponseHeaders(
  record: Readonly<Record<string, string>>,
  inherited?: Readonly<Record<string, string>>,
): StaticResponseHeaders {
  const frozen = Object.freeze({ ...record })
  const jsonHeaders = new Headers({ ...frozen, "content-type": JSON_CONTENT_TYPE })
  let responseJson: ResponseInit | undefined
  return {
    record: frozen,
    entries: Object.freeze(Object.entries(frozen)),
    jsonHeaders,
    jsonInit200: { status: 200, headers: jsonHeaders },
    inherited,
    responseJsonInit200: () => {
      responseJson ??= {
        status: 200,
        headers: new Headers({ ...frozen, "content-type": responseJsonContentType() }),
      }
      return responseJson
    },
  }
}

/**
 * Apply the static defaults to an ALREADY-BUILT response - the framework's error/404/timeout renders
 * and a handler-returned `Response`, none of which go through the header init below. Defaults, so a
 * name the response already carries is left alone, and a response needing none is returned untouched.
 * The writes land on {@link writableResponse}'s answer, never on an object other requests may share;
 * `request` is the request being answered.
 */
export function applyStaticResponseHeaders(
  response: Response,
  statics: StaticResponseHeaders,
  request?: Request,
): Response {
  let target = response
  const entries = statics.entries
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const current = response.headers.get(entry[0])
    // Set by the request, or already the declared value: nothing to write.
    if (current === entry[1] || current !== (statics.inherited?.[entry[0]] ?? null)) continue
    if (target === response) target = writableResponse(response, request)
    target.headers.set(entry[0], entry[1])
  }
  return target
}

/**
 * Build a JSON response carrying the declared headers, the cheapest way this runtime allows.
 *
 * Everywhere but Deno that is one constructor call with the prebuilt init. Deno charges far more to
 * ingest a header init than to mutate a built response's `Headers` - the same asymmetry the
 * caller-set-headers path above already routes around - and handing it the prebuilt init measured
 * 15% BELOW writing the same headers from a response hook, which would make declaring them a
 * pessimization on that runtime.
 */
function staticJsonResponse(
  body: string,
  status: number,
  statics: StaticResponseHeaders,
  contentType: string,
  init: ResponseInit,
): Response {
  if (IS_DENO) {
    return denoResponseWithJsonBody(
      body,
      status,
      statics.record as Record<string, string>,
      contentType,
    )
  }
  // lgtm [js/stack-trace-exposure] `body` is already serialized; ordinary thrown errors are replaced
  // with the fixed internal-error envelope before reaching this response boundary.
  return new Response(body, init)
}

function withStatics(
  response: Response,
  statics: StaticResponseHeaders | undefined,
  request: Request | undefined,
): Response {
  return statics === undefined ? response : applyStaticResponseHeaders(response, statics, request)
}

function applyStaticDefaults(headers: Headers, statics: StaticResponseHeaders): void {
  // Indexed with an explicit tuple read, not `for...of` with array destructuring: the destructuring
  // pattern is itself an iterator walk, so the pair form pays two iterator protocols per header.
  // Measured on a 5-header set: 211ns cheaper on Bun, 56ns on Node.
  const entries = statics.entries
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    // Absent, or still an enclosing scope's value rather than one the request set: this one applies.
    if (headers.get(entry[0]) === (statics.inherited?.[entry[0]] ?? null))
      headers.set(entry[0], entry[1])
  }
}

/** Fold the static defaults under whatever shape the request's own headers took. */
function withStaticHeaderInit(
  own: Record<string, string> | Headers | undefined,
  statics: StaticResponseHeaders,
): Record<string, string> | Headers {
  if (own === undefined) return statics.record
  if (own instanceof Headers) {
    // Freshly built by `headersInit` for the cookies case, so mutating it in place is safe.
    applyStaticDefaults(own, statics)
    return own
  }
  return mergeStaticHeaderRecord(statics.record, own) as Record<string, string>
}

// Deno's Response/Headers implementation ingests a plain header record much more slowly than it
// mutates an already-created response (the difference is material on realistic middleware routes
// that add several security/CORS headers). Bun is faster on the record constructor, so keep the
// portable constructor path there and select the Deno-specific shape only for Web responses that
// carry a plain record. The first request lazily probes Deno's native JSON content-type so this
// preserves the runtime's Response.json contract instead of baking in Bun's charset suffix.
const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const IS_DENO = typeof (globalThis as { Deno?: unknown }).Deno !== "undefined"
let denoJsonContentType: string | undefined

export function responseJsonContentType(): string {
  if (denoJsonContentType === undefined) {
    denoJsonContentType = Response.json(0).headers.get("content-type") ?? "application/json"
  }
  return denoJsonContentType
}

function denoResponseWithJsonBody(
  body: string,
  status: number,
  headers: Record<string, string>,
  defaultContentType = responseJsonContentType(),
): Response {
  // lgtm [js/stack-trace-exposure] this body is serialized data; ordinary thrown errors are replaced
  // with the fixed internal-error envelope before reaching this response boundary.
  const response = new Response(body, { status })
  let hasContentType = false
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value)
    if (name.toLowerCase() === "content-type") {
      hasContentType = true
    }
  }
  if (!hasContentType) response.headers.set("content-type", defaultContentType)
  return response
}

/**
 * Render a JSON value with caller-owned headers on the runtimes where mutating the response is
 * cheaper than asking the Response constructor to ingest a record. Node deliberately stays on the
 * record path: its undici implementation is a little faster there, and its production HTTP adapter
 * normally uses the direct node outcome anyway. The two operations are equivalent at the Web
 * boundary: Response.json supplies the same default content type, then the caller's headers override
 * it exactly as `withJsonContentType` did.
 */
function jsonResponseWithOwnHeaders(
  result: object,
  status: number,
  headers: Record<string, string>,
): Response {
  const response = status === 200 ? Response.json(result) : Response.json(result, { status })
  for (const name of Object.keys(headers)) response.headers.set(name, headers[name]!)
  return withBody(response)
}

// The framework-buffered-body marker shared with the Node adapter: a Response carrying it exposes
// its already-serialized bytes without draining. On the Web serving paths it exists ONLY when a
// registered body/raw hook needs it, so hook-less apps pay nothing.
const RESPONSE_BODY = Symbol.for(NODE_BRIDGE_MARKER_KEYS.responseBody)

/**
 * Responses known to carry a body and take header writes: framework renders built with one, and
 * foreign ones `writableResponse` has already checked. A body is sent once, so such a response belongs
 * to whichever request holds it and is written in place without reading `.body` again - on Bun that
 * read turns a string body into a stream, measured at about 6% of a request.
 */
const WRITABLE_BODY_RESPONSES = new WeakSet<Response>()

/**
 * Body-less responses nifra built for one request - `writableResponse` copies and the framework's own
 * body-less renders - by that request. Only objects nifra constructs are entered, never one a handler
 * or hook hands over, so the request's later writers write them in place and any other request that
 * is handed one copies it.
 */
const REQUEST_OWNED = new WeakMap<Response, Request>()

function ownedBy(response: Response, request: Request | undefined): Response {
  if (request !== undefined) REQUEST_OWNED.set(response, request)
  return response
}

/** Record a Response the framework constructed: one built with a body is single-use and writable. */
export function rememberRenderedResponse(response: Response, hasBody: boolean): Response {
  if (hasBody) WRITABLE_BODY_RESPONSES.add(response)
  return response
}

/** `rememberRenderedResponse` for a Response the framework constructed with a body. */
function withBody(response: Response): Response {
  WRITABLE_BODY_RESPONSES.add(response)
  return response
}

const HEADER_MUTABILITY_PROBE = "x-nifra-header-probe"

/** Whether `headers` takes writes. A guarded `Headers` rejects the first one, so the probe changes
 * nothing either way. */
function headersTakeWrites(headers: Headers): boolean {
  try {
    const previous = headers.get(HEADER_MUTABILITY_PROBE)
    headers.set(HEADER_MUTABILITY_PROBE, "1")
    if (previous === null) headers.delete(HEADER_MUTABILITY_PROBE)
    else headers.set(HEADER_MUTABILITY_PROBE, previous)
  } catch {
    return false
  }
  return true
}

/**
 * The response to write headers on for the request being answered: `response` itself, or a copy.
 *
 * A Response without a body can be sent any number of times, so the object a handler, hook or cache
 * hands over may be answering other requests too - a module-level `new Response(null, { status: 204 })`,
 * a kept redirect, even one nifra rendered earlier. A cookie or per-request header written onto it would
 * ship with every later request it answers, so it is always copied, whoever built it. One with a body
 * can be sent only once, so it already belongs to this request and is written in place; a copy would
 * cost Bun's file responses their sendfile path and buy nothing. Guarded `Headers`
 * (`Response.redirect()`, a raw `fetch()` result) reject writes, so those are copied as well.
 *
 * Pass the `request` being answered and a copy made for it is written in place by its later writers;
 * handed back on any other request, that copy is copied again.
 */
export function writableResponse(response: Response, request?: Request): Response {
  if (WRITABLE_BODY_RESPONSES.has(response)) return response
  if (response.body === null) {
    // A 101 upgrade and the status-0 `Response.error()` cannot be constructed, and a runtime makes
    // them per request.
    if (response.status < 200) return response
    if (request !== undefined && REQUEST_OWNED.get(response) === request) return response
    const copy = copiedResponse(
      response,
      new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      false,
    )
    return ownedBy(copy, request)
  }
  if (headersTakeWrites(response.headers)) {
    WRITABLE_BODY_RESPONSES.add(response)
    return response
  }
  return copiedResponse(response, new Response(response.body, response), true)
}

/** `copy`, recorded and carrying `original`'s buffered-body marker: the Node writer still sends the
 * serialized bytes directly, and a marked body-less Response keeps the body only the marker holds. */
function copiedResponse(original: Response, copy: Response, hasBody: boolean): Response {
  const marker: unknown = Reflect.get(original, RESPONSE_BODY)
  if (marker !== undefined) Object.defineProperty(copy, RESPONSE_BODY, { value: marker })
  return rememberRenderedResponse(copy, hasBody)
}

function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304
}

/** Normalize handler-produced bodyless responses before response middleware sees them. */
export function normalizeBodylessResponse(response: Response, request?: Request): Response {
  if (!isBodylessStatus(response.status)) return response
  if (response.body === null && !response.headers.has("content-length")) return response
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return ownedBy(
    new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    request,
  )
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
  withBody(response)
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
  statics?: StaticResponseHeaders,
  unstamped = false,
  request?: Request,
): Response {
  // With no response hook registered, no code path ever asks whether this response takes writes in
  // place, so recording it in the body WeakSet is dead work - `Response.json` alone is cheaper on Bun
  // than the same construction plus the WeakSet write. `unstamped` is the caller's assertion that the
  // hook walk is empty; an app that registers ANY response hook keeps the record, because the
  // alternative is `writableResponse` reading `.body` and probing the headers of every response (each
  // one is fresh, so nothing amortizes) - the probe alone measured 19% slower than the WeakSet write.
  // Default false: an unknown caller pays one WeakSet write rather than a probe per response.
  if (
    unstamped &&
    (tagResponseBody === false || tagResponseBody === undefined) &&
    statics === undefined &&
    result !== undefined &&
    typeof result === "object" &&
    result !== null &&
    !(result instanceof Response) &&
    !isResponseResult(result)
  ) {
    return Response.json(result)
  }
  if (
    result !== undefined &&
    !(result instanceof Response) &&
    typeof result === "object" &&
    result !== null &&
    !isResponseResult(result)
  ) {
    // Deno's cheapest shape for this lane is its own `Response.json` (which fuses serialization and
    // construction natively, and sets the content-type natively) followed by post-construction header
    // writes - NOT a header init, which measured 15% below writing the same names from a hook. So on
    // Deno the tier's only saving here is the response walk itself; every other runtime keeps the
    // one-call prebuilt init below.
    if (statics !== undefined && IS_DENO && !tagResponseBody) {
      const response = Response.json(result)
      // Indexed for the same reason as `applyStaticDefaults`: pair destructuring is a second
      // iterator walk per header.
      for (let i = 0; i < statics.entries.length; i++) {
        const entry = statics.entries[i]!
        response.headers.set(entry[0], entry[1])
      }
      return withBody(response)
    }
    // With declared static headers the prebuilt init already carries them plus the JSON
    // content-type, so this lane still constructs the response in one call - the whole point of
    // declaring headers statically instead of writing them per response.
    if (tagResponseBody || statics !== undefined) {
      const body = JSON.stringify(result) as string | undefined
      // Each shape carries the content-type of the lane it stands in for: the framework's own for the
      // tagging path this branch already owned, and `Response.json`'s for the construction below that
      // the static tier replaces. They differ on Deno, and a declared header must not change one.
      if (body !== undefined)
        return tagged(
          statics === undefined
            ? new Response(body, JSON_INIT_200)
            : tagResponseBody
              ? staticJsonResponse(body, 200, statics, JSON_CONTENT_TYPE, statics.jsonInit200)
              : staticJsonResponse(
                  body,
                  200,
                  statics,
                  responseJsonContentType(),
                  statics.responseJsonInit200(),
                ),
          body,
          tagResponseBody,
        )
    }
    return withBody(
      statics === undefined
        ? Response.json(result)
        : Response.json(result, statics.responseJsonInit200()),
    )
  }
  return toResponse(
    result as HandlerResult,
    EMPTY_RESPONSE_CONTROLS,
    tagResponseBody,
    statics,
    request,
  )
}

/** Fused-lane respond with a context: read `c.set` once; untouched (the common case) -> the fast
 * JSON respond; touched -> the generic `toResponse` with those controls (statuses, headers, cookies). */
export function fusedRespond(
  result: unknown,
  ctx: RawContext,
  tagResponseBody: ResponseBodyTagOption = false,
  statics?: StaticResponseHeaders,
  unstamped = false,
): Response {
  const set = ctx[CONTEXT_SET]()
  const request = unstamped ? undefined : ctx[CONTEXT_REQUEST]
  if (set === undefined)
    return fusedRespondNoSet(result, tagResponseBody, statics, unstamped, request)
  return toResponse(result as HandlerResult, set, tagResponseBody, statics, request)
}

/**
 * Render a handler's result. `request` is the request being answered, given when response hooks will
 * write next: a copy or body-less response built here is then recorded as that request's own, so the
 * hooks write it in place instead of copying it again.
 */
export function toResponse(
  result: HandlerResult,
  set: CtxSet,
  tagResponseBody: ResponseBodyTagOption = false,
  statics?: StaticResponseHeaders,
  request?: Request,
): Response {
  if (isResponseResult(result)) {
    const plain = result.plain
    if (plain !== undefined) {
      // Rendered as the value it is, on the branches below, rather than through `toResponse()`: the
      // status and headers fold into a `set` and the body takes the ordinary JSON lane. One level
      // only - a plain render's body is a user value, never another response carrier.
      return toResponse(
        plain.body as HandlerResult,
        plainRenderSet(plain, set),
        tagResponseBody,
        statics,
        request,
      )
    }
    return withStatics(
      appendCookiesToResponse(
        normalizeBodylessResponse(result.toResponse(), request),
        set,
        request,
      ),
      statics,
      request,
    )
  }
  if (result instanceof Response) {
    if (result.bodyUsed) {
      return toResponse(SENT_BODY, EMPTY_RESPONSE_CONTROLS, false, statics, request)
    }
    return withStatics(
      appendCookiesToResponse(normalizeBodylessResponse(result, request), set, request),
      statics,
      request,
    )
  }
  return renderValue(result, set, tagResponseBody, statics, request)
}

/**
 * Render a framework {@link ResponseResult} - a rejection such as a `413`, `415` or `422` - with no
 * request controls, byte-identical to `toResponse(result, EMPTY_RESPONSE_CONTROLS)`. It never takes a
 * handler's `Response`, so a compact server rendering only its own rejections ships none of the code
 * that adopts one.
 */
export function renderResult(result: ResponseResult): Response {
  const plain = result.plain
  return plain === undefined
    ? normalizeBodylessResponse(result.toResponse())
    : renderValue(
        plain.body,
        plainRenderSet(plain, EMPTY_RESPONSE_CONTROLS),
        false,
        undefined,
        undefined,
      )
}

/** The JSON lane: a value that is neither a `Response` nor a response result, rendered with the
 * request's status, headers and cookies. */
function renderValue(
  result: unknown,
  set: CtxSet,
  tagResponseBody: ResponseBodyTagOption,
  statics: StaticResponseHeaders | undefined,
  request: Request | undefined,
): Response {
  // The static tier only changes WHICH prebuilt header shape the branches below reach for: the
  // request's own headers are folded on top of the declared defaults once, here.
  const own = headersInit(set)
  const headers = statics === undefined ? own : withStaticHeaderInit(own, statics)
  const jsonCtHeaders = statics === undefined ? JSON_CT_HEADERS : statics.jsonHeaders
  const status = set.status ?? (result === undefined ? 204 : 200)
  if (status === 204 || status === 205 || status === 304) {
    return ownedBy(
      new Response(null, headers === undefined ? { status } : { status, headers }),
      request,
    )
  }
  // Bun and Deno both make a JSON response first and then accept a few header mutations more cheaply
  // than ingesting the same plain record in the constructor. This is the common dynamic-header
  // shape (`c.set.headers`) after all cookies/static-header/tagging cases have been excluded. Keep the
  // Node record path unchanged: its Web constructor wins by a small margin, and the native Node
  // adapter's normal route finalizer does not build this Response in the first place.
  if (
    own !== undefined &&
    !(own instanceof Headers) &&
    statics === undefined &&
    (set._cookies === undefined || set._cookies.length === 0) &&
    (IS_BUN || IS_DENO) &&
    !tagResponseBody &&
    result !== undefined &&
    typeof result === "object" &&
    result !== null
  ) {
    return jsonResponseWithOwnHeaders(result, status, own)
  }
  if (own === undefined && result !== undefined) {
    // Fast respond (profiled ~50 ns/req faster on every plain-JSON return): `JSON.stringify` + a
    // prebuilt init beats `Response.json`'s internal init handling. Output is byte-identical -
    // same body bytes, same probed content-type. `undefined` from stringify (a function/symbol
    // result) delegates to Response.json so its TypeError contract stays the single source.
    const body = JSON.stringify(result) as string | undefined
    if (body !== undefined) {
      const init: ResponseInit =
        status === 200
          ? (statics?.jsonInit200 ?? JSON_INIT_200)
          : { status, headers: jsonCtHeaders }
      return tagged(
        statics === undefined
          ? // lgtm [js/stack-trace-exposure] the serialized body is not a caught error stack.
            new Response(body, init)
          : staticJsonResponse(body, status, statics, JSON_CONTENT_TYPE, init),
        body,
        tagResponseBody,
      )
    }
  }
  const init: ResponseInit = headers === undefined ? { status } : { status, headers }
  if (result === undefined) return ownedBy(new Response(null, init), request)
  if (tagResponseBody) {
    const body = JSON.stringify(result) as string | undefined
    if (body !== undefined) {
      const response =
        IS_DENO && !(headers instanceof Headers)
          ? denoResponseWithJsonBody(
              body,
              status,
              headers as Record<string, string>,
              JSON_CT_HEADERS.get("content-type") ?? "application/json;charset=utf-8",
            )
          : // lgtm [js/stack-trace-exposure] the serialized body is not a caught error stack.
            new Response(body, { status, headers: withJsonContentType(headers) })
      return tagged(
        response,
        body,
        typeof tagResponseBody === "object" ? tagResponseBody : undefined,
      )
    }
  }
  if (IS_DENO && headers !== undefined && !(headers instanceof Headers)) {
    const body = JSON.stringify(result) as string | undefined
    if (body !== undefined) return withBody(denoResponseWithJsonBody(body, status, headers))
  }
  return withBody(Response.json(result, init))
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

export function appendCookiesToResponse(
  response: Response,
  set: CtxSet,
  request?: Request,
): Response {
  // A handler may queue cookies (`c.set.cookie` - e.g. a session cookie) AND return its own Response
  // (e.g. `redirect("/")` after login). Cookies accumulate additively, so append them to the
  // returned Response - otherwise the canonical set-session-then-redirect pattern would silently drop
  // the cookie. (Other `c.set` fields stay the returned Response's own concern.) They are this
  // request's cookies, so they go on `writableResponse`'s answer, never on an object another request
  // may be served from.
  const cookies = set._cookies
  if (cookies === undefined || cookies.length === 0) return response
  const target = writableResponse(response, request)
  for (const cookie of cookies) target.headers.append("set-cookie", cookie)
  return target
}

/** What a handler's Response renders as when its body was already sent: a runtime refuses to send it
 * again, and the headers it carries were written for the request it already answered. */
export const SENT_BODY = plainError(500, "internal_error")
