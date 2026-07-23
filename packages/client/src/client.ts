import type { ContractShape, RegistryFor } from "@nifrajs/core/contract"
import {
  type BackendMount,
  type BackendMountHandler,
  NIFRA_BACKEND_MOUNT,
} from "@nifrajs/core/mount"
import {
  createTransportCodecRegistry,
  decodeTransportResponse,
  plainJsonCodec,
  type TransportCodec,
  type TransportCodecRegistry,
} from "@nifrajs/core/transport-codec"
import type { ApiError, Result } from "./result.ts"
import type { Subscription, Treaty, TreatyFromRegistry } from "./treaty.ts"
import { ResponseContractViolation, withResponseValidation } from "./validate-responses.ts"
import { NO_SOCKET, openWebSocket } from "./ws.ts"

const HTTP_VERBS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
])
const BODY_VERBS: ReadonlySet<string> = new Set(["post", "put", "patch"])

/**
 * The fetch shape the client needs — looser than `typeof fetch` so an in-process bridge or a
 * test mock satisfies it without the extra members (`.preconnect`, overloads) of the global.
 */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

type MaybePromise<T> = T | Promise<T>

/** Safe retry policy. Off unless `retry` is set; retries ONLY idempotent methods and transient 5xx —
 * never a 4xx/429 and never a non-idempotent method, so a retry can't double a side effect. */
export interface ClientRetryOptions {
  /** Max RETRIES after the first attempt. Default 2. */
  readonly attempts?: number
  /** Response statuses to retry. Default `[502, 503, 504]`. 4xx/429 are never added by default. */
  readonly on?: readonly number[]
  /** Methods eligible for retry. Default the idempotent set `GET/HEAD/OPTIONS/PUT/DELETE`. */
  readonly methods?: readonly string[]
  /** Delay (ms) before retry `n` (1-based). Default exponential backoff with jitter, capped at 3s. */
  readonly backoff?: (attempt: number) => number
}

export interface ClientOptions {
  /** Headers sent on every request (a per-call `headers` option is merged on top). */
  readonly headers?: Record<string, string>
  /** Override the `fetch` implementation (tests, an in-process bridge, a custom agent, etc.). */
  readonly fetch?: FetchFn
  /**
   * Runs before each request (including each retry). Return a header map to MERGE onto the outgoing
   * request — the place to inject a fresh auth token. `await`ed, so async token refresh works.
   */
  readonly onRequest?: (request: {
    readonly url: string
    readonly method: string
    readonly headers: Record<string, string>
    readonly body: unknown
  }) => MaybePromise<Record<string, string> | undefined>
  /** Runs after a response arrives (once per call, on the final response). Observe-only. */
  readonly onResponse?: (response: {
    readonly url: string
    readonly method: string
    readonly response: Response
  }) => MaybePromise<void>
  /** Abort a call that takes longer than this many ms. Surfaces as `{ ok: false, status: 0 }` with a
   * `timeout` error, never a throw. Combined with a per-call `signal`. */
  readonly timeoutMs?: number
  /** Enable safe automatic retries. See {@link ClientRetryOptions}. */
  readonly retry?: ClientRetryOptions
  /**
   * Opt into a versioned transport representation. Plain JSON remains the default. Responses are
   * decoded through the bounded registry, and WebSocket frames use the same codec.
   */
  readonly transport?: {
    readonly codec: TransportCodec
    readonly registry?: TransportCodecRegistry
    readonly maxBytes?: number
  }
}

const DEFAULT_RETRY_STATUSES: readonly number[] = [502, 503, 504]
const IDEMPOTENT_METHODS: readonly string[] = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]

function defaultBackoff(attempt: number): number {
  return Math.min(300 * 2 ** (attempt - 1), 3000) + Math.random() * 100
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Combine a per-call signal with a timeout into one signal; also returns the timeout signal so the
 * caller can tell a timeout abort from a caller abort. */
function buildSignal(
  userSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal?: AbortSignal | undefined; timeout?: AbortSignal | undefined } {
  const timeout =
    timeoutMs !== undefined && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined
  const parts = [userSignal, timeout].filter((s): s is AbortSignal => s !== undefined)
  if (parts.length === 0) return {}
  if (parts.length === 1) return { signal: parts[0], timeout }
  const signal = typeof AbortSignal.any === "function" ? AbortSignal.any(parts) : parts[0]
  return { signal, timeout }
}

/** Typed route client plus the explicit platform-aware backend mount capability. */
export type InProcessClient<App> = Treaty<App> & BackendMount

export interface InProcessClientOptions extends Omit<ClientOptions, "fetch"> {
  /**
   * Assert every JSON response against the route's declared contract — `schema.response` for 2xx,
   * `schema.errors[status]` for declared failures — and THROW on mismatch, so a handler whose real
   * output drifts from its schema fails the test instead of passing silently. Statuses with no
   * declared schema, non-JSON bodies, and 204/205/HEAD pass through unchecked. Test-focused: the
   * check parses a clone of each JSON body, a cost that belongs in tests, not production hot paths.
   */
  readonly validateResponses?: boolean
}

interface CallOptions {
  readonly query?: Record<string, unknown>
  readonly headers?: Record<string, string>
  readonly signal?: AbortSignal
}

/**
 * Create an end-to-end-typed client for a nifra server. Two modes:
 *
 *   // coupled — typed from the server's type (`typeof app`)
 *   const api = client<typeof app>("http://localhost:3000")
 *
 *   // decoupled — typed from a contract VALUE, no server import
 *   const api = client(contract, "https://api.example.com")
 *
 *   const { data, error } = await api.users({ id: "1" }).get()
 *
 * Both return the same Eden-style proxy. Browser-safe: uses only `fetch` /
 * `Proxy` / `URL`, never the server runtime. Never throws — network and non-2xx
 * responses surface as a `Result` `error`.
 */
export function client<App>(baseUrl: string, options?: ClientOptions): Treaty<App>
export function client<const C extends ContractShape>(
  contract: C,
  baseUrl: string,
  options?: ClientOptions,
): TreatyFromRegistry<RegistryFor<C>>
export function client(
  arg1: string | ContractShape,
  arg2?: string | ClientOptions,
  arg3?: ClientOptions,
): unknown {
  const baseUrl = typeof arg1 === "string" ? arg1 : (arg2 as string)
  const options = (typeof arg1 === "string" ? (arg2 as ClientOptions | undefined) : arg3) ?? {}
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl
  // The contract value (decoupled mode) is only a type carrier here; the runtime
  // proxy needs just the base URL. (Client-side validation from the contract's
  // schemas is a future enhancement.)
  return createProxy(base, "", options)
}

/**
 * A {@link client} whose `fetch` calls a nifra app's own `fetch` in-process — no network, full
 * lifecycle (validation, middleware, contracts). For SSR loaders. Typed from `App` exactly like
 * the network client. The `(url, init) → Request` bridge is required because the client calls
 * `fetch(url, init)` while `app.fetch` takes a `Request`.
 *
 * The returned proxy also implements the explicit symbol-keyed {@link BackendMount} interface, so
 * `createWebApp({ api: inProcessClient(backend) })` can auto-mount the backend while forwarding the
 * outer runtime's `env` and `waitUntil`.
 */
export function inProcessClient<
  App extends { fetch(request: Request): Response | Promise<Response> },
>(app: App, options?: InProcessClientOptions): InProcessClient<App> {
  // The in-process bridge: the client speaks `fetch(url, init)` (the `FetchFn` shape) while the app's
  // own `fetch` takes a `Request`. It is the proxy's per-call transport; the symbol-keyed mount below
  // is the platform-aware auto-mount path.
  const direct: FetchFn = (url, init) => Promise.resolve(app.fetch(new Request(url, init)))
  const bridge = options?.validateResponses === true ? withResponseValidation(app, direct) : direct
  const mount: BackendMountHandler = (request, platform) =>
    Promise.resolve((app.fetch as BackendMountHandler)(request, platform))
  // NO_SOCKET marks the options so a typed `.ws()` call fails with a real explanation — an
  // in-process app has no socket to upgrade — instead of dialing ws://nifra.internal into the void.
  const proxy = client<App>("http://nifra.internal", {
    ...options,
    fetch: bridge,
    [NO_SOCKET]: true,
  } as ClientOptions)
  // An outer Proxy intercepts only the explicit mount symbol, delegating every typed route segment
  // unchanged (`api.users({ id }).get()`).
  return new Proxy(proxy as object, {
    get(targetProxy, key, receiver) {
      if (key === NIFRA_BACKEND_MOUNT) return mount
      return Reflect.get(targetProxy, key, receiver)
    },
  }) as InProcessClient<App>
}

/**
 * The in-process test client — the Fastify-`inject` / supertest equivalent for nifra. Drives the
 * app's own `fetch` directly: no server, no port, no network, the full real lifecycle (validation,
 * middleware, contracts, auth), and end-to-end types from `App`. Calls never throw — branch on
 * `res.ok`. An alias of {@link inProcessClient} with a test-focused name; identical behavior.
 *
 * ```ts
 * import { testClient } from "@nifrajs/client"
 * import { app } from "../src/app"
 *
 * const api = testClient<typeof app>(app)
 * const res = await api.users({ id: "42" }).get()
 * expect(res.ok && res.data.id).toBe("42")
 * ```
 */
export const testClient = inProcessClient

function createProxy(base: string, path: string, options: ClientOptions): unknown {
  const target = (): void => {}
  return new Proxy(target, {
    get(_target, key) {
      // `then` guard: keep an un-awaited node proxy from looking like a thenable.
      if (typeof key !== "string" || key === "then") return undefined
      if (HTTP_VERBS.has(key.toLowerCase())) {
        return (...args: unknown[]): Promise<Result<unknown>> =>
          execute(base, path, key.toLowerCase(), args, options)
      }
      // Typed SSE subscription for `app.sse()` routes. Like `fetch` on the in-process client,
      // `subscribe` is a reserved proxy key — a literal `/subscribe` path segment is unreachable
      // through the typed proxy (no nifra app defines one reached this way).
      if (key === "subscribe") {
        return (onEvent: (event: unknown) => void, subscribeOptions?: SubscribeCallOptions) =>
          subscribeSse(base, path, onEvent, subscribeOptions, options)
      }
      // Typed WebSocket handle for `app.ws()` routes — `ws` is a reserved proxy key like `subscribe`.
      if (key === "ws") {
        return (wsOptions?: Parameters<typeof openWebSocket>[2]) =>
          openWebSocket(
            base,
            path,
            {
              headers: options.headers,
              ...wsOptions,
              ...(options.transport === undefined ? {} : { transport: options.transport }),
            },
            NO_SOCKET in options,
          )
      }
      // `index` addresses the root path "/" and adds no segment.
      return createProxy(base, key === "index" ? path : `${path}/${key}`, options)
    },
    apply(_target, _thisArg, args) {
      // A param call (`api.users({ id })`): append the single value, encoded — encoding "/"
      // round-trips through the server's decode, so wildcards and params share this one path.
      // The Treaty type requires the object, but the runtime must stay graceful: a no-arg call
      // (`api.users()`) or empty object (`api.users({})`) must NOT throw — the client's contract is
      // to never throw — nor synthesize an `"undefined"` path segment. With no value, fall through
      // to the bare path, which the server resolves as an ordinary `{ ok: false }` (404) Result.
      const first = args[0]
      const value =
        first !== null && typeof first === "object"
          ? Object.values(first as Record<string, unknown>)[0]
          : first
      if (value === undefined || value === null) return createProxy(base, path, options)
      return createProxy(base, `${path}/${encodeURIComponent(String(value))}`, options)
    },
  })
}

async function execute(
  base: string,
  path: string,
  verb: string,
  args: unknown[],
  options: ClientOptions,
): Promise<Result<unknown>> {
  const isBodyVerb = BODY_VERBS.has(verb)
  const body = isBodyVerb ? args[0] : undefined
  const callOptions = (isBodyVerb ? args[1] : args[0]) as CallOptions | undefined

  let url = base + (path === "" ? "/" : path)
  const query = callOptions?.query ? buildQuery(callOptions.query) : ""
  if (query !== "") url += `?${query}`

  const method = verb.toUpperCase()
  const headers: Record<string, string> = { ...options.headers, ...callOptions?.headers }
  if (options.onRequest !== undefined) {
    const extra = await options.onRequest({ url, method, headers, body })
    if (extra !== undefined) Object.assign(headers, extra)
  }
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    const codec = options.transport?.codec ?? plainJsonCodec
    init.body = codec.encode(body)
    headers["content-type"] = codec.mediaType
    if (options.transport !== undefined) headers.accept ??= codec.mediaType
  }
  const { signal, timeout } = buildSignal(callOptions?.signal, options.timeoutMs)
  if (signal !== undefined) init.signal = signal

  // Safe retry: only when configured, only for idempotent methods + transient statuses, so a retry
  // can never duplicate a side effect (a POST is never retried unless the app opts its method in).
  const retry = options.retry
  const maxRetries = retry === undefined ? 0 : (retry.attempts ?? 2)
  const retryStatuses = new Set(retry?.on ?? DEFAULT_RETRY_STATUSES)
  const retryMethods = new Set((retry?.methods ?? IDEMPOTENT_METHODS).map((m) => m.toUpperCase()))
  const methodRetryable = retryMethods.has(method)
  const backoff = retry?.backoff ?? defaultBackoff
  const doFetch = options.fetch ?? fetch

  let response: Response
  let attempt = 0
  for (;;) {
    try {
      response = await doFetch(url, init)
    } catch (error) {
      // A contract violation is a test assertion (validateResponses), not a call outcome — let it
      // fail the test instead of degrading into a `Result` the test would happily branch on.
      if (error instanceof ResponseContractViolation) throw error
      if (methodRetryable && attempt < maxRetries) {
        attempt += 1
        await delay(backoff(attempt))
        continue
      }
      const code = timeout?.aborted === true ? "timeout" : "network_error"
      return { ok: false, status: 0, data: null, error: { error: code } }
    }
    if (methodRetryable && attempt < maxRetries && retryStatuses.has(response.status)) {
      attempt += 1
      await delay(backoff(attempt))
      continue
    }
    break
  }

  if (options.onResponse !== undefined) await options.onResponse({ url, method, response })

  const data = await parseBody(response, options)
  if (response.ok) {
    return { ok: true, status: response.status, data, error: null }
  }
  // On failure, `data` carries the parsed error body (typed from the route's `errors` contract);
  // `error` is the server's normalized `{ error, issues }` summary.
  return { ok: false, status: response.status, data, error: toApiError(data) }
}

// --- typed SSE subscriptions (fetch-based, so it works over ANY fetcher: network, in-process, tests) ---

interface SubscribeCallOptions {
  readonly query?: Record<string, unknown>
  readonly headers?: Record<string, string>
  readonly signal?: AbortSignal
  readonly reconnect?: boolean | { baseDelayMs?: number; maxDelayMs?: number }
  readonly onError?: (error: unknown) => void
  readonly onClose?: () => void
}

/** One parsed SSE frame (the fields the client consumes). */
interface SseFrame {
  data?: string
  id?: string
  retry?: number
}

/**
 * Incrementally parse a `text/event-stream` body, invoking `onFrame` per dispatched event.
 * Implements the SSE wire format: `data:` accumulates multi-line, `id:`/`retry:` update stream
 * state, `:` lines are comments, a blank line dispatches.
 */
async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let dataLines: string[] = []
  let frame: SseFrame = {}

  const dispatch = (): void => {
    if (dataLines.length > 0) frame.data = dataLines.join("\n")
    if (frame.data !== undefined || frame.id !== undefined || frame.retry !== undefined) {
      onFrame(frame)
    }
    dataLines = []
    frame = {}
  }

  const handleLine = (line: string): void => {
    if (line === "") {
      dispatch()
      return
    }
    if (line.startsWith(":")) return // comment / keep-alive
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") dataLines.push(value)
    else if (field === "id") frame.id = value
    else if (field === "retry") {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) frame.retry = parsed
    }
    // `event:` names pass through untyped for now — the contract types the data payload.
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline === -1) break
        const line = buffer.slice(0, newline).replace(/\r$/, "")
        buffer = buffer.slice(newline + 1)
        handleLine(line)
      }
    }
    buffer += decoder.decode()
    if (buffer !== "") handleLine(buffer.replace(/\r$/, ""))
    dispatch() // an unterminated final frame still dispatches
  } finally {
    reader.releaseLock()
  }
}

/**
 * The `.subscribe()` runtime for `app.sse()` routes. fetch-based (never `EventSource`), so it
 * streams over the configured fetcher — network, an in-process bridge, or a test mock — with
 * EventSource semantics where they matter: auto-reconnect with backoff + jitter (honoring the
 * server's `retry:` hint), `Last-Event-ID` resumption, JSON-parsed typed events. Never throws:
 * failures reach `onError`; a terminal end reaches `onClose`.
 */
function subscribeSse(
  base: string,
  path: string,
  onEvent: (event: unknown) => void,
  callOptions: SubscribeCallOptions | undefined,
  options: ClientOptions,
): Subscription {
  const controller = new AbortController()
  let closed = false
  let lastEventId: string | undefined
  let serverRetryMs: number | undefined

  const reconnectConfig = callOptions?.reconnect ?? true
  const reconnectEnabled = reconnectConfig !== false
  const baseDelayMs =
    (typeof reconnectConfig === "object" ? reconnectConfig.baseDelayMs : undefined) ?? 1_000
  const maxDelayMs =
    (typeof reconnectConfig === "object" ? reconnectConfig.maxDelayMs : undefined) ?? 15_000

  if (callOptions?.signal !== undefined) {
    if (callOptions.signal.aborted) closed = true
    else callOptions.signal.addEventListener("abort", () => close(), { once: true })
  }

  const close = (): void => {
    if (closed) return
    closed = true
    controller.abort()
    callOptions?.onClose?.()
  }

  let url = base + (path === "" ? "/" : path)
  const query = callOptions?.query ? buildQuery(callOptions.query) : ""
  if (query !== "") url += `?${query}`
  const doFetch = options.fetch ?? fetch

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      ;(timer as { unref?: () => void }).unref?.()
      controller.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })

  void (async () => {
    let attempt = 0
    while (!closed) {
      try {
        const headers: Record<string, string> = {
          ...options.headers,
          ...callOptions?.headers,
          accept: "text/event-stream",
          ...(lastEventId !== undefined ? { "last-event-id": lastEventId } : {}),
        }
        const response = await doFetch(url, { headers, signal: controller.signal })
        if (!response.ok || response.body === null) {
          throw new Error(`sse_http_${response.status}`)
        }
        attempt = 0 // a successful connect resets the backoff
        await readSseStream(response.body, (frame) => {
          if (frame.id !== undefined) lastEventId = frame.id
          if (frame.retry !== undefined) serverRetryMs = frame.retry
          if (frame.data !== undefined) {
            try {
              onEvent(JSON.parse(frame.data))
            } catch (error) {
              callOptions?.onError?.(error)
            }
          }
        })
        // Clean server-side end: a finite stream (`reconnect: false`) completes here.
        if (!reconnectEnabled) {
          close()
          return
        }
      } catch (error) {
        if (closed || controller.signal.aborted) return
        callOptions?.onError?.(error)
        if (!reconnectEnabled) {
          close()
          return
        }
      }
      if (closed) return
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
      attempt = Math.min(attempt + 1, 10)
      const wait = serverRetryMs ?? backoff / 2 + Math.random() * (backoff / 2)
      await delay(wait)
    }
  })()

  return { close }
}

function buildQuery(query: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item))
    } else {
      params.set(key, String(value))
    }
  }
  return params.toString()
}

function transportRegistry(options: ClientOptions): TransportCodecRegistry {
  if (options.transport?.registry !== undefined) return options.transport.registry
  const codec = options.transport?.codec
  return codec === undefined || codec === plainJsonCodec
    ? createTransportCodecRegistry([plainJsonCodec])
    : createTransportCodecRegistry([plainJsonCodec, codec])
}

async function parseBody(response: Response, options: ClientOptions): Promise<unknown> {
  if (response.status === 204) return undefined
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (
    contentType.startsWith("application/json") ||
    contentType.startsWith("application/vnd.nifra.")
  ) {
    return await decodeTransportResponse(response, transportRegistry(options), {
      ...(options.transport?.maxBytes === undefined
        ? {}
        : { maxBytes: options.transport.maxBytes }),
    })
  }
  const text = await response.text()
  if (text === "") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text // a non-JSON body (e.g. a plain-text Response) is returned as-is
  }
}

function toApiError(data: unknown): ApiError {
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "string"
  ) {
    // Trust the server's `{ error, issues }` shape (it's what nifra emits).
    const issues =
      "issues" in data && Array.isArray(data.issues)
        ? (data.issues as ApiError["issues"])
        : undefined
    return issues !== undefined ? { error: data.error, issues } : { error: data.error }
  }
  return { error: "request_failed" }
}
