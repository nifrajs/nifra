/**
 * The opt-in idempotency request lane. Installed by `.use(idempotency())` and reached only by routes
 * that declare `schema.idempotency`, so the kernel never statically imports this code: a bare
 * `server()` tree-shakes the whole dedupe machinery out.
 *
 * The kernel resolves a route's declared idempotency at registration (via {@link IdempotencyRuntime.resolve})
 * and, on the request path, hands a matched idempotent route to {@link IdempotencyRuntime.run}. Server
 * execution is supplied as a callback; the opt-in module owns body preparation, cleanup, and replay
 * without adding that machinery to the shared server kernel.
 */
import { RouteConfigError } from "../errors.ts"
import {
  canonicalizeIdempotencyBody,
  computeIdempotencyFingerprint,
  DEFAULT_IDEMPOTENCY_HEADER,
  DEFAULT_IDEMPOTENCY_PENDING_TTL_MS,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  IdempotencyResponseTooLargeError,
  type IdempotencyStore,
  MemoryIdempotencyStore,
  responseFromStored,
  serializeResponse,
  validIdempotencyKey,
  validIdempotencyNamespace,
} from "../idempotency.ts"
import {
  beginRequestEffectTracking,
  markEffect,
  requestEffectEvidence,
  requestIsSafeToRetry,
} from "../internal/effect-execution.ts"
import type { InternalHandler, RouteEntry } from "../internal/route-execution.ts"
import type { IdempotencyResume } from "../internal/route-program.ts"
import { markTransportCap, readBoundedBytes, transportCapOf, UNLIMITED_BODY_BYTES } from "./body.ts"
import type { Platform, RouteSchema } from "./context.ts"
import { jsonError, urlPartsOf } from "./http.ts"
import { INSTALL_IDEMPOTENCY } from "./install.ts"
import { CONTEXT_REQUEST, PRE_DECODED_BODY, preDecodedBody, requestOf } from "./runtime-core.ts"
import type { AnyServer, IdentityPlugin, RawContext, RequestSource } from "./server.ts"

/** Requests whose route handler was entered. One rejected before it - by auth, validation, a guard -
 * began no execution, so its key is released rather than stored. */
const HANDLER_ENTERED = new WeakSet<Request>()

/** The gate's half of a body teed by {@link prepareRequest}, and the request's platform. */
interface PreparedRequest {
  readonly body: ReadableStream<Uint8Array> | null
  readonly route: ReadableStream<Uint8Array> | null
  readonly cancel?: () => void
  readonly platform: Platform | undefined
  /** Why the request could not be copied; the gate rethrows it inside the route's error handling. */
  readonly failure?: { readonly error: unknown }
}

const PREPARED = new WeakMap<Request, PreparedRequest>()

/** Statuses that say the request was not carried out (RFC 9110). A handler answering with one, with no
 * owned effect begun, releases its key, so a refused caller cannot hold a store entry for the TTL. */
const REFUSALS = new Set([401, 403, 408, 409, 425, 429])

/** Registration-resolved idempotency for a route: the config with its store + defaults pinned. */
export interface ResolvedIdempotency {
  readonly store: IdempotencyStore
  readonly ttlMs: number
  /** The lease renewed while a handler runs; unset when the store cannot renew. */
  readonly pendingTtlMs: number | undefined
  readonly headerName: string
  readonly namespace: NonNullable<RouteSchema["idempotency"]>["namespace"]
  readonly maxResponseBytes: number
}

/** The injected idempotency implementation the kernel calls through when the plugin is installed. */
export interface IdempotencyRuntime {
  readonly trackEffect: (context: object, committed: boolean) => void
  /** Resolve a route's declared idempotency into a pinned store + defaults, or `undefined` when off. */
  resolve(
    schema: RouteSchema | undefined,
    authenticated: boolean,
    maxBodyBytes: number,
  ): ResolvedIdempotency | undefined
  /** Wrap an idempotent route's handler so the lane can tell a request rejected before it ran. */
  wrapHandler<C extends { readonly req: Request }>(
    handler: (context: C) => unknown,
  ): (context: C) => unknown
  /** Prepare the body lanes and release their owned reader on every response, error or deadline. */
  run(
    source: RequestSource,
    platform: Platform | undefined,
    execute: (request: Request) => Response | Promise<Response>,
  ): Promise<Response>
  /**
   * The dedupe gate, entered from inside the route program: after authentication on an auth-first
   * route, first on any other, and always under the request deadline. It reads the key, fingerprints
   * the payload, consults the store, then resumes the program, replays, or rejects.
   */
  gate(
    entry: RouteEntry,
    ctx: RawContext,
    wrapResponse: (response: Response) => Response,
    resume: IdempotencyResume<Response>,
    fail: (error: unknown) => Response | Promise<Response>,
  ): Promise<Response>
}

/** The install seam a server exposes so the `idempotency()` plugin can hand it a runtime. */
interface IdempotencyInstallable {
  [INSTALL_IDEMPOTENCY](runtime: IdempotencyRuntime): void
}

/**
 * Enable request idempotency. Routes that declare `schema.idempotency` get the dedupe lane: a repeat
 * `Idempotency-Key` rechecks the current route prerequisites (authentication, validation and policy
 * hooks) before replaying the stored response. The handler, effect ledger and stored response
 * transformations run only for the fresh request. Without this plugin,
 * declaring `schema.idempotency` is a registration error (the safety gate can never be silently
 * dropped). `store` is the app-wide default backing routes that do not pin their own; omit it for a
 * shared in-process store (development/tests only - inject a durable store in production).
 */
export interface IdempotencyPluginOptions {
  readonly store?: IdempotencyStore | undefined
}

export function idempotency(options?: IdempotencyPluginOptions): IdentityPlugin {
  const runtime = createIdempotencyRuntime(options)
  const apply = <S extends AnyServer>(app: S): S => {
    ;(app as unknown as IdempotencyInstallable)[INSTALL_IDEMPOTENCY](runtime)
    return app
  }
  return Object.assign(apply, { pluginName: "nifra:idempotency" }) as IdentityPlugin
}

/**
 * Build an idempotency runtime. `store` is the app-wide default backing routes that declare
 * `schema.idempotency` without their own `store`; when omitted, a shared in-process
 * {@link MemoryIdempotencyStore} is created lazily on first idempotent route.
 */
export function createIdempotencyRuntime(options?: IdempotencyPluginOptions): IdempotencyRuntime {
  const configuredStore = options?.store
  let lazyStore: IdempotencyStore | undefined
  const defaultStore = (): IdempotencyStore => {
    if (configuredStore !== undefined) return configuredStore
    lazyStore ??= new MemoryIdempotencyStore()
    return lazyStore
  }

  return {
    trackEffect(context, committed) {
      markEffect(context, committed)
    },
    wrapHandler(handler) {
      return (context) => {
        HANDLER_ENTERED.add(context.req)
        return handler(context)
      }
    },
    resolve(schema, authenticated, maxBodyBytes) {
      const config = schema?.idempotency
      if (config === undefined) return undefined
      if (schema?.sse !== undefined) {
        throw new RouteConfigError(
          "INVALID_IDEMPOTENCY",
          "streaming/SSE responses cannot be used on an idempotency route",
        )
      }
      const store = config.store ?? defaultStore()
      if (config.scope === "durable" && store.durability !== "durable") {
        throw new RouteConfigError(
          "INVALID_IDEMPOTENCY",
          'durable idempotency requires a durable store (store.durability must be "durable")',
        )
      }
      const ttlMs = config.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
        throw new RouteConfigError(
          "INVALID_IDEMPOTENCY",
          "idempotency ttlMs must be a finite positive number",
        )
      }
      const pendingTtlMs = config.pendingTtlMs
      if (
        pendingTtlMs !== undefined &&
        (store.renew === undefined || !Number.isSafeInteger(pendingTtlMs) || pendingTtlMs <= 0)
      ) {
        throw new RouteConfigError(
          "INVALID_IDEMPOTENCY",
          "idempotency pendingTtlMs must be a positive integer, on a store that implements renew()",
        )
      }
      const headerName = (config.headerName ?? DEFAULT_IDEMPOTENCY_HEADER).toLowerCase()
      try {
        new Headers().set(headerName, "probe")
      } catch {
        throw new RouteConfigError(
          "INVALID_IDEMPOTENCY",
          `invalid idempotency header name ${JSON.stringify(headerName)}`,
        )
      }
      const namespace = config.namespace
      if (namespace === undefined) {
        throw new RouteConfigError(
          "INVALID_IDEMPOTENCY",
          "idempotency namespace is required; use a principal resolver or an explicit shared scope",
        )
      }
      if (typeof namespace === "string" && !validIdempotencyNamespace(namespace)) {
        throw new RouteConfigError(
          "INVALID_IDEMPOTENCY",
          `invalid idempotency namespace ${JSON.stringify(namespace)}`,
        )
      }
      if (authenticated && typeof namespace !== "function") {
        throw new RouteConfigError(
          "INVALID_IDEMPOTENCY",
          "authenticated idempotency routes require a principal namespace resolver",
        )
      }
      const maxResponseBytes = config.maxResponseBytes ?? maxBodyBytes
      if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
        throw new RouteConfigError(
          "INVALID_IDEMPOTENCY",
          "idempotency maxResponseBytes must be a positive integer",
        )
      }
      return Object.freeze({
        store,
        ttlMs,
        pendingTtlMs:
          store.renew === undefined
            ? undefined
            : (pendingTtlMs ?? DEFAULT_IDEMPOTENCY_PENDING_TTL_MS),
        headerName,
        namespace,
        maxResponseBytes,
      })
    },

    async run(source, platform, execute) {
      const request = prepareRequest(source, platform)
      try {
        return await execute(request)
      } finally {
        finishRequest(request)
      }
    },

    gate(entry, ctx, wrapResponse, resume, fail) {
      let escaped: { readonly error: unknown } | undefined
      const resumed: IdempotencyResume<Response> = async (next, program) => {
        try {
          return await resume(next, program)
        } catch (error) {
          escaped = { error }
          throw error
        }
      }
      return admit(entry, ctx, wrapResponse, resumed).catch((error: unknown) => {
        // A failure the resumed program let escape has met its error boundary already.
        if (escaped !== undefined && escaped.error === error) throw error
        return fail(error)
      })
    },
  }
}

/** The gate proper; {@link IdempotencyRuntime.gate} hands its own failures to the route's boundary. */
async function admit(
  entry: RouteEntry,
  ctx: RawContext,
  wrapResponse: (response: Response) => Response,
  resume: IdempotencyResume<Response>,
): Promise<Response> {
  const config = entry.idempotent
  const req = ctx[CONTEXT_REQUEST]
  const prepared = PREPARED.get(req)
  if (config === undefined || prepared === undefined)
    throw new Error("idempotency: the route ran on an unprepared request")
  if (prepared.failure !== undefined) throw prepared.failure.error
  const maxBodyBytes = entry.bodyLimit ?? UNLIMITED_BODY_BYTES
  const key = req.headers.get(config.headerName)
  if (key === null || !validIdempotencyKey(key)) {
    return wrapResponse(jsonError(400, "idempotency_key_required"))
  }
  const namespace =
    typeof config.namespace === "function"
      ? await config.namespace(
          { method: req.method, url: req.url, headers: req.headers },
          prepared.platform,
        )
      : config.namespace
  if (!validIdempotencyNamespace(namespace)) {
    return wrapResponse(jsonError(500, "idempotency_namespace_invalid"))
  }
  // A codec-decoded body reached the route as a stand-in: fingerprint what the caller sent.
  const decoded = preDecodedBody(req)
  let bytes: Uint8Array
  let contentType: string
  if (decoded !== undefined) {
    releaseGateHalf(prepared.body)
    if (decoded.byteLength > maxBodyBytes) return wrapResponse(jsonError(413, "payload_too_large"))
    bytes = decoded.encoded
    contentType = decoded.contentType
  } else {
    const read = await readBoundedBytes(gateCopy(req, prepared.body), maxBodyBytes)
    if (!read.ok) {
      return wrapResponse(
        jsonError(read.status, read.status === 413 ? "payload_too_large" : "bad_request"),
      )
    }
    bytes = read.bytes
    contentType = req.headers.get("content-type") ?? ""
  }
  // Past the deadline the kernel has already answered; claim nothing for a request it abandoned.
  if (ctx.signal.aborted) return wrapResponse(jsonError(503, "request_timeout"))
  const url = urlPartsOf(req.url)
  const fingerprint = await computeIdempotencyFingerprint(
    req.method,
    `${url.pathname}${url.search}`,
    canonicalizeIdempotencyBody(bytes, contentType),
    contentType,
  )

  const pendingTtlMs = config.pendingTtlMs
  const begin = await config.store.begin({
    namespace,
    key,
    fingerprint,
    ttlMs: config.ttlMs,
    pendingTtlMs,
  })
  if (begin.state === "mismatch") return wrapResponse(jsonError(409, "idempotency_key_reused"))
  if (begin.state === "in-flight") {
    return wrapResponse(jsonError(409, "idempotency_in_progress", { "Retry-After": "1" }))
  }
  if (begin.state === "capacity") {
    return wrapResponse(jsonError(503, "idempotency_store_capacity", { "Retry-After": "1" }))
  }
  if (ctx.signal.aborted) {
    if (begin.state === "new") {
      await config.store.abandon({ namespace, key, reservation: begin.reservation })
    }
    return wrapResponse(jsonError(503, "request_timeout"))
  }
  beginRequestEffectTracking(req)
  if (begin.state === "replay") {
    const replay = replayEntry(
      entry,
      responseFromStored(begin.response, { maxBytes: config.maxResponseBytes }),
    )
    return await resume(replay, replay.program)
  }
  const reservation = begin.reservation
  let heartbeat: ReturnType<typeof setInterval> | undefined
  if (pendingTtlMs !== undefined) {
    // Renew the lease while the handler runs: only a process that died stops renewing, so its
    // key frees after the lease rather than the replay TTL.
    heartbeat = setInterval(() => {
      // A failed renewal only lets the lease lapse, which completion then reports.
      Promise.resolve()
        .then(() => config.store.renew?.({ namespace, key, reservation, ttlMs: pendingTtlMs }))
        .catch(() => undefined)
    }, pendingTtlMs / 3)
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a Node or Bun timer has unref(); on other runtimes the optional call does nothing.
    ;(heartbeat as { unref?: () => void }).unref?.()
  }
  try {
    // The handler threw, or its response body failed while being captured: no response to store.
    const settleThrown = async (err: unknown): Promise<Response> => {
      if (!requestEffectEvidence(req).began) {
        // The request-local boundary proves no owned effect started, so this is the one safe case
        // where releasing the key cannot duplicate an effect.
        await config.store.abandon({ namespace, key, reservation })
        throw err
      }
      // A committed or ambiguous effect must never be repeated. Persist a payload-free terminal
      // response even though the normal handler lifecycle escaped without producing one.
      const terminal = new Response(null, { status: 500 })
      const completed = await config.store.complete({
        namespace,
        key,
        reservation,
        response: await serializeResponse(terminal, { maxBytes: config.maxResponseBytes }),
      })
      if (!completed) {
        return wrapResponse(jsonError(503, "idempotency_reservation_lost", { "Retry-After": "1" }))
      }
      return wrapResponse(terminal)
    }
    let response: Response
    try {
      response = await resume(pastGate(entry), entry.program)
    } catch (err) {
      return await settleThrown(err)
    }
    if (!HANDLER_ENTERED.has(req) && !requestEffectEvidence(req).began) {
      // Rejected before the handler ran: no execution began, so there is nothing a retry could
      // duplicate and no result is saved - storing every rejection would let callers who never
      // pass auth fill the store and lock everyone else out.
      const abandoned = await config.store.abandon({ namespace, key, reservation })
      if (!abandoned) {
        return wrapResponse(jsonError(503, "idempotency_reservation_lost", { "Retry-After": "1" }))
      }
      return wrapResponse(response)
    }
    if (
      (REFUSALS.has(response.status) || (response.status >= 500 && requestIsSafeToRetry(req))) &&
      !requestEffectEvidence(req).began
    ) {
      const abandoned = await config.store.abandon({ namespace, key, reservation })
      if (!abandoned) {
        return wrapResponse(jsonError(503, "idempotency_reservation_lost", { "Retry-After": "1" }))
      }
      return wrapResponse(response)
    }
    // Once the handler ran, every other concrete response is terminal for this key. A non-2xx may
    // follow an already-committed external effect; abandoning it would let a retry duplicate it.
    let storedResponse: Awaited<ReturnType<typeof serializeResponse>>
    try {
      storedResponse = await serializeResponse(response, { maxBytes: config.maxResponseBytes })
    } catch (error) {
      if (!(error instanceof IdempotencyResponseTooLargeError)) return await settleThrown(error)
      // The effect may already have happened, so never abandon and permit a duplicate execution.
      // Commit a small terminal response under the winning key and return that same response now.
      response = jsonError(507, "idempotency_response_too_large")
      try {
        storedResponse = await serializeResponse(response, {
          maxBytes: config.maxResponseBytes,
        })
      } catch (terminalError) {
        if (!(terminalError instanceof IdempotencyResponseTooLargeError)) throw terminalError
        // Even an intentionally tiny bound must remain truthful. An empty 507 preserves terminal
        // status + replay safety without silently storing more bytes than the route permits.
        response = new Response(null, { status: 507 })
        storedResponse = await serializeResponse(response, {
          maxBytes: config.maxResponseBytes,
        })
      }
    }
    const completed = await config.store.complete({
      namespace,
      key,
      reservation,
      response: storedResponse,
    })
    if (!completed) {
      return wrapResponse(jsonError(503, "idempotency_reservation_lost", { "Retry-After": "1" }))
    }
    return wrapResponse(response)
  } finally {
    clearInterval(heartbeat)
  }
}

function prepareRequest(source: RequestSource, platform: Platform | undefined): Request {
  const request = requestOf(source)
  let prepared = request
  let state: PreparedRequest
  let input: ReturnType<typeof ownedInput> | undefined
  try {
    input = ownedInput(request.body)
    const [route, gate] = input.body === null ? [null, null] : input.body.tee()
    state = { body: gate, route, cancel: input.cancel, platform }
    const init: StreamingRequestInit = {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      body: route,
      duplex: "half",
    }
    prepared = new Request(request.url, init)
    const decoded = preDecodedBody(request)
    if (decoded !== undefined) Object.defineProperty(prepared, PRE_DECODED_BODY, { value: decoded })
  } catch (error) {
    // A request that cannot be copied (a body an earlier hook already read) still enters the
    // program, so the failure surfaces from the gate like any other route error.
    input?.cancel()
    state = { body: null, route: null, platform, failure: { error } }
  }
  // The lanes, and any hook an auth-first route runs before the gate, read this copy's body.
  const cap = transportCapOf(source)
  if (cap !== undefined) markTransportCap(prepared, cap)
  PREPARED.set(prepared, state)
  return prepared
}

function finishRequest(request: Request): void {
  const state = PREPARED.get(request)
  if (state === undefined) return
  state.cancel?.()
  releaseGateHalf(state.body)
  releaseGateHalf(state.route)
}

type StreamingRequestInit = RequestInit & { readonly duplex: "half" }

/** Own the source reader so cancellation cannot be held hostage by an unread or locked tee branch. */
function ownedInput(body: ReadableStream<Uint8Array> | null): {
  readonly body: ReadableStream<Uint8Array> | null
  readonly cancel: () => void
} {
  if (body === null) return { body: null, cancel() {} }
  const reader = body.getReader()
  let ended = false
  let controller: ReadableStreamDefaultController<Uint8Array>
  const cancel = (): void => {
    if (ended) return
    ended = true
    controller.error(new DOMException("Request finished", "AbortError"))
    // Cleanup must not wait for an upstream producer's cancellation promise.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return {
    cancel,
    body: new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
      async pull(output) {
        try {
          const chunk = await reader.read()
          if (ended) return
          if (chunk.done) output.close()
          else output.enqueue(chunk.value)
        } catch (error) {
          output.error(error)
        }
      },
      cancel,
    }),
  }
}

/** The gate's half of the body under the request's own framing headers, for the bounded reader. */
function gateCopy(request: Request, body: ReadableStream<Uint8Array> | null): Request {
  const init: StreamingRequestInit = {
    method: body === null ? "GET" : "POST",
    headers: request.headers,
    body,
    duplex: "half",
  }
  return new Request(request.url, init)
}

/** Drop the gate's unread half of the body; a failed cancel has no caller left to report to. */
function releaseGateHalf(body: ReadableStream<Uint8Array> | null): void {
  body?.cancel().catch(() => {})
}

// The entry a program resumes on past its gate: the same route without idempotency, so a program
// re-entered from the top does not meet the gate again. One per route, built on first use.
const PAST_GATE = new WeakMap<RouteEntry, RouteEntry>()
function pastGate(entry: RouteEntry): RouteEntry {
  let past = PAST_GATE.get(entry)
  if (past === undefined) {
    past = { ...entry, idempotent: undefined }
    PAST_GATE.set(entry, past)
  }
  return past
}

function replayEntry(entry: unknown, response: Response): RouteEntry {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the kernel supplies its matched RouteEntry through this internal opaque install seam.
  const route = entry as RouteEntry
  const handler: InternalHandler = () => response
  return {
    ...route,
    handler,
    idempotent: undefined,
    responseContract: undefined,
    program: { ...route.program, handler, afterHandle: [] },
  }
}
