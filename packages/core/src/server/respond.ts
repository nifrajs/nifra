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
): StaticResponseHeaders {
  const frozen = Object.freeze({ ...record })
  const jsonHeaders = new Headers({ ...frozen, "content-type": JSON_CONTENT_TYPE })
  let responseJson: ResponseInit | undefined
  return {
    record: frozen,
    entries: Object.freeze(Object.entries(frozen)),
    jsonHeaders,
    jsonInit200: { status: 200, headers: jsonHeaders },
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
 * name the response already carries is left alone. A guarded `Headers` (a raw `fetch()` result a
 * handler returned) rejects every write, so the first `set` throws with nothing applied and the
 * retry lands on a mutable copy.
 */
export function applyStaticResponseHeaders(
  response: Response,
  statics: StaticResponseHeaders,
): Response {
  const headers = response.headers
  if (knownMutableHeaders(headers)) {
    applyStaticDefaults(headers, statics)
    return response
  }
  try {
    applyStaticDefaults(headers, statics)
  } catch {
    const clone = new Response(response.body, response)
    applyStaticDefaults(clone.headers, statics)
    return stamped(clone)
  }
  rememberMutableHeaders(headers)
  return response
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
  return new Response(body, init)
}

function withStatics(response: Response, statics: StaticResponseHeaders | undefined): Response {
  return statics === undefined ? response : applyStaticResponseHeaders(response, statics)
}

function applyStaticDefaults(headers: Headers, statics: StaticResponseHeaders): void {
  for (const [name, value] of statics.entries) {
    if (!headers.has(name)) headers.set(name, value)
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
const IS_DENO = typeof (globalThis as { Deno?: unknown }).Deno !== "undefined"
let denoJsonContentType: string | undefined

function responseJsonContentType(): string {
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

// The framework-buffered-body marker shared with the Node adapter: a Response carrying it exposes
// its already-serialized bytes without draining. On the Web serving paths it exists ONLY when a
// registered body/raw hook needs it, so hook-less apps pay nothing.
const RESPONSE_BODY = Symbol.for("nifra.response.body")

/**
 * Headers objects the framework itself constructed - guaranteed mutable, no guard. Response
 * middleware adapters consult this before falling back to a mutability probe, so the hot path
 * (every framework-rendered response) never pays per-request `Headers` operations to learn what
 * construction already knew; only a handler-returned foreign `Response` (a raw `fetch()` result,
 * whose headers are guarded immutable) reaches the probe.
 */
const MUTABLE_RESPONSE_HEADERS = new WeakSet<Headers>()

export function knownMutableHeaders(headers: Headers): boolean {
  return MUTABLE_RESPONSE_HEADERS.has(headers)
}

export function rememberMutableHeaders(headers: Headers): void {
  MUTABLE_RESPONSE_HEADERS.add(headers)
}

/** Stamp a framework-constructed Response's headers as known-mutable, and return it. */
function stamped(response: Response): Response {
  MUTABLE_RESPONSE_HEADERS.add(response.headers)
  return response
}

function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304
}

/** Normalize handler-produced bodyless responses before response middleware sees them. */
export function normalizeBodylessResponse(response: Response): Response {
  if (!isBodylessStatus(response.status)) return response
  if (response.body === null && !response.headers.has("content-length")) return response
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return stamped(
    new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
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
  stamped(response)
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
): Response {
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
      for (const [name, value] of statics.entries) response.headers.set(name, value)
      return stamped(response)
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
    return stamped(
      statics === undefined
        ? Response.json(result)
        : Response.json(result, statics.responseJsonInit200()),
    )
  }
  return toResponse(result as HandlerResult, EMPTY_RESPONSE_CONTROLS, tagResponseBody, statics)
}

/** Fused-lane respond with a context: read `c.set` once; untouched (the common case) -> the fast
 * JSON respond; touched -> the generic `toResponse` with those controls (statuses, headers, cookies). */
export function fusedRespond(
  result: unknown,
  ctx: RawContext,
  tagResponseBody: ResponseBodyTagOption = false,
  statics?: StaticResponseHeaders,
): Response {
  const set = ctx[CONTEXT_SET]()
  if (set === undefined) return fusedRespondNoSet(result, tagResponseBody, statics)
  return toResponse(result as HandlerResult, set, tagResponseBody, statics)
}

export function toResponse(
  result: HandlerResult,
  set: CtxSet,
  tagResponseBody: ResponseBodyTagOption = false,
  statics?: StaticResponseHeaders,
): Response {
  if (isResponseResult(result)) {
    return withStatics(
      appendCookiesToResponse(normalizeBodylessResponse(result.toResponse()), set),
      statics,
    )
  }
  if (result instanceof Response) {
    return withStatics(appendCookiesToResponse(normalizeBodylessResponse(result), set), statics)
  }
  // The static tier only changes WHICH prebuilt header shape the branches below reach for: the
  // request's own headers are folded on top of the declared defaults once, here.
  const own = headersInit(set)
  const headers = statics === undefined ? own : withStaticHeaderInit(own, statics)
  const jsonCtHeaders = statics === undefined ? JSON_CT_HEADERS : statics.jsonHeaders
  const status = set.status ?? (result === undefined ? 204 : 200)
  if (status === 204 || status === 205 || status === 304) {
    return stamped(new Response(null, headers === undefined ? { status } : { status, headers }))
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
          ? new Response(body, init)
          : staticJsonResponse(body, status, statics, JSON_CONTENT_TYPE, init),
        body,
        tagResponseBody,
      )
    }
  }
  const init: ResponseInit = headers === undefined ? { status } : { status, headers }
  if (result === undefined) return stamped(new Response(null, init))
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
          : new Response(body, { status, headers: withJsonContentType(headers) })
      return tagged(
        response,
        body,
        typeof tagResponseBody === "object" ? tagResponseBody : undefined,
      )
    }
  }
  if (IS_DENO && headers !== undefined && !(headers instanceof Headers)) {
    const body = JSON.stringify(result) as string | undefined
    if (body !== undefined) return stamped(denoResponseWithJsonBody(body, status, headers))
  }
  return stamped(Response.json(result, init))
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
