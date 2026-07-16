/**
 * The opt-in idempotency request lane. Installed by `.use(idempotency())` and reached only by routes
 * that declare `schema.idempotency`, so the kernel never statically imports this code: a bare
 * `server()` tree-shakes the whole dedupe machinery out.
 *
 * The kernel resolves a route's declared idempotency at registration (via {@link IdempotencyRuntime.resolve})
 * and, on the request path, hands a matched idempotent route to {@link IdempotencyRuntime.run}. Everything
 * server-specific is supplied through {@link IdempotencyHost} so this module depends on no server internals.
 */
import { RouteConfigError } from "../errors.ts"
import {
  canonicalizeIdempotencyBody,
  computeIdempotencyFingerprint,
  DEFAULT_IDEMPOTENCY_HEADER,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  IdempotencyResponseTooLargeError,
  type IdempotencyStore,
  MemoryIdempotencyStore,
  responseFromStored,
  serializeResponse,
  validIdempotencyKey,
  validIdempotencyNamespace,
} from "../idempotency.ts"
import { readBoundedBytes } from "./body.ts"
import type { Platform, RouteSchema } from "./context.ts"
import { jsonError, urlPartsOf } from "./http.ts"
import { INSTALL_IDEMPOTENCY } from "./install.ts"
import type { AnyServer, IdentityPlugin } from "./server.ts"

/** Registration-resolved idempotency for a route: the config with its store + defaults pinned. */
export interface ResolvedIdempotency {
  readonly store: IdempotencyStore
  readonly ttlMs: number
  readonly headerName: string
  readonly namespace: NonNullable<RouteSchema["idempotency"]>["namespace"]
  readonly maxResponseBytes: number
}

/**
 * What the dedupe lane needs from the server to run a fresh key: the app-wide body cap and a way to
 * run the buffered request through the route's normal lanes to a concrete `Response`.
 */
export interface IdempotencyHost {
  readonly maxBodyBytes: number
  runLanes(
    buffered: Request,
    platform: Platform | undefined,
    entry: unknown,
    params: Record<string, string>,
    search: string | undefined,
  ): Promise<Response>
}

/** The injected idempotency implementation the kernel calls through when the plugin is installed. */
export interface IdempotencyRuntime {
  /** Resolve a route's declared idempotency into a pinned store + defaults, or `undefined` when off. */
  resolve(
    schema: RouteSchema | undefined,
    authenticated: boolean,
    maxBodyBytes: number,
  ): ResolvedIdempotency | undefined
  /** The dedupe lane: read the key, fingerprint the request, consult the store, run/replay/reject. */
  run<T>(
    config: ResolvedIdempotency,
    req: Request,
    platform: Platform | undefined,
    entry: unknown,
    params: Record<string, string>,
    search: string | undefined,
    wrapResponse: (response: Response) => T,
    host: IdempotencyHost,
  ): Promise<T>
}

/** The install seam a server exposes so the `idempotency()` plugin can hand it a runtime. */
interface IdempotencyInstallable {
  [INSTALL_IDEMPOTENCY](runtime: IdempotencyRuntime): void
}

/**
 * Enable request idempotency. Routes that declare `schema.idempotency` get the dedupe lane: a repeat
 * `Idempotency-Key` replays the stored response instead of re-running the handler. Without this plugin,
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

const RESPONSE_2XX_LOWER = 200
const RESPONSE_2XX_UPPER = 300

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
        headerName,
        namespace,
        maxResponseBytes,
      })
    },

    async run(config, req, platform, entry, params, search, wrapResponse, host) {
      const key = req.headers.get(config.headerName)
      if (key === null || !validIdempotencyKey(key)) {
        return wrapResponse(jsonError(400, "idempotency_key_required"))
      }
      const namespace =
        typeof config.namespace === "function"
          ? await config.namespace(req.clone(), platform)
          : config.namespace
      if (!validIdempotencyNamespace(namespace)) {
        return wrapResponse(jsonError(500, "idempotency_namespace_invalid"))
      }
      const read = await readBoundedBytes(req, host.maxBodyBytes)
      if (!read.ok) {
        return wrapResponse(
          jsonError(read.status, read.status === 413 ? "payload_too_large" : "bad_request"),
        )
      }
      const url = urlPartsOf(req.url)
      const canonicalBody = canonicalizeIdempotencyBody(read.bytes, req.headers.get("content-type"))
      const fingerprint = await computeIdempotencyFingerprint(
        req.method,
        `${url.pathname}${url.search}`,
        canonicalBody,
        req.headers.get("content-type") ?? "",
      )

      const begin = await config.store.begin({ namespace, key, fingerprint, ttlMs: config.ttlMs })
      if (begin.state === "replay") {
        return wrapResponse(
          responseFromStored(begin.response, { maxBytes: config.maxResponseBytes }),
        )
      }
      if (begin.state === "mismatch") return wrapResponse(jsonError(409, "idempotency_key_reused"))
      if (begin.state === "in-flight") {
        return wrapResponse(jsonError(409, "idempotency_in_progress", { "Retry-After": "1" }))
      }
      if (begin.state === "capacity") {
        return wrapResponse(jsonError(503, "idempotency_store_capacity", { "Retry-After": "1" }))
      }
      const reservation = begin.reservation

      // Fresh key: re-expose the buffered body as a Request so the normal lanes can read + validate it,
      // then run those lanes to a concrete Response.
      const bufferedInit: RequestInit = {
        method: req.method,
        headers: req.headers,
        signal: req.signal,
      }
      if (read.bytes.byteLength > 0)
        bufferedInit.body = read.bytes as NonNullable<RequestInit["body"]>
      const buffered = new Request(req.url, bufferedInit)
      let response: Response
      try {
        response = await host.runLanes(buffered, platform, entry, params, search)
      } catch (err) {
        // The lanes never throw (errors resolve to a 500 Response), but stay fail-safe: release the
        // reservation so a retry isn't wedged, then re-throw.
        await config.store.abandon({ namespace, key, reservation })
        throw err
      }
      // Cache only successful responses; release the key on any error so the client can retry.
      if (response.status >= RESPONSE_2XX_LOWER && response.status < RESPONSE_2XX_UPPER) {
        let storedResponse: Awaited<ReturnType<typeof serializeResponse>>
        try {
          storedResponse = await serializeResponse(response, { maxBytes: config.maxResponseBytes })
        } catch (error) {
          if (!(error instanceof IdempotencyResponseTooLargeError)) throw error
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
          return wrapResponse(
            jsonError(503, "idempotency_reservation_lost", { "Retry-After": "1" }),
          )
        }
      } else {
        await config.store.abandon({ namespace, key, reservation })
      }
      return wrapResponse(response)
    },
  }
}
