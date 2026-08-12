/**
 * The edge adapter: a nifra app presented as a Cloudflare-Workers-shaped `ExportedHandler`.
 *
 * ## Why this is not in the server kernel
 *
 * `toFetchHandler` never touches the `Server` class. It takes a STRUCTURAL app - anything with `fetch`, and
 * optionally `resolveWebSocketUpgrade` - which is what lets it wrap an app it has no access to the
 * internals of, and what makes it a separate concern from the kernel rather than a method on it. It sat
 * in `server.ts` for no reason other than that both were written the same week.
 *
 * The types here are all structural too (`ExecutionContext`, `ScheduledController`,
 * `DurableObjectNamespaceLike`), so `@nifrajs/core` declares the Workers surface it needs instead of
 * depending on `@cloudflare/workers-types`. The real Workers types satisfy them.
 *
 * The `MaybePromise` import is type-only and erased, so there is no runtime cycle back into the kernel.
 */
import type { Platform } from "./context.ts"
import type { MaybePromise } from "./server.ts"
import type { StandardWebSocket, WebSocketUpgradeOutcome } from "./websocket.ts"

/** A Cloudflare Workers-style execution context (the `fetch` 3rd arg). Structural - only
 * `waitUntil` is used; declared here so `@nifrajs/core` needs no Workers type dependency. */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

/** A Cloudflare Workers-style scheduled (cron) controller. Structural - no Workers type dependency. */
export interface ScheduledController {
  /** Epoch ms the run was scheduled for. */
  readonly scheduledTime: number
  /** The matching cron expression from `wrangler.toml` `[triggers]`. */
  readonly cron: string
  /** Tell the platform not to retry this run on failure. */
  noRetry(): void
}

/** A nifra cron handler: the platform controller + the same typed `env`/`waitUntil` nifra threads into
 * request handlers. Schedule background work with `waitUntil` so it outlives the trigger. */
export type ScheduledHandler<Env = unknown> = (
  controller: ScheduledController,
  context: { readonly env: Env; waitUntil(promise: Promise<unknown>): void },
) => MaybePromise<void>

/** Cloudflare's `WebSocketPair` - feature-detected (absent off Workers). Yields `{ 0: client, 1: server }`. */
type WebSocketPairCtor = new () => {
  readonly 0: unknown
  readonly 1: StandardWebSocket & { accept(): void }
}

/** Structural view of a Cloudflare Durable Object namespace binding - keeps `@cloudflare/workers-types`
 * out of `@nifrajs/core`. The real `DurableObjectNamespace` satisfies it. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}

/** The single hub Durable Object id nifra routes WS upgrades to (one hub per app - see `@nifrajs/workers`). */
const NIFRA_WS_HUB_ID = "nifra-ws-hub"

/**
 * Adapt a nifra app to an edge "ExportedHandler" - use it as a Cloudflare Workers (or any
 * `fetch(request, env, ctx)` runtime) default export. It threads `env` + `ctx.waitUntil` into the
 * nifra Context, so handlers read `c.env` and schedule background work via `c.waitUntil`:
 *
 *   export default toFetchHandler(app)
 *
 * Pass `{ scheduled }` to also export a Workers cron handler (for a `[triggers]` schedule) - it
 * receives the platform controller plus the same typed `env`/`waitUntil`:
 *
 *   export default toFetchHandler(app, {
 *     scheduled: (controller, { env, waitUntil }) =>
 *       waitUntil(env.KV.put("last-run", String(controller.scheduledTime))),
 *   })
 *
 * No Workers-only deps - `app.fetch` stays a portable Web-standard handler; this is the thin
 * shim from the platform's 3-arg `fetch`/`scheduled` to it.
 */
export function toFetchHandler<Env = unknown>(
  app: {
    fetch(request: Request, platform?: Platform<Env>): MaybePromise<Response>
    resolveWebSocketUpgrade?(
      request: Request,
      platform?: Platform<Env>,
    ): MaybePromise<WebSocketUpgradeOutcome>
  },
  options?: {
    scheduled?: ScheduledHandler<Env>
    /**
     * Route WebSocket upgrades to a Durable Object that holds the connections and runs the app's
     * pub/sub - enabling cross-connection broadcast (`app.publish`) on Cloudflare Workers, where a
     * stateless isolate can't. Pass the DO namespace binding from `env`; pair with `@nifrajs/workers`'
     * `createWebSocketHub(app)` (the DO class) + a `wrangler.toml` binding. Without this, WS upgrades use
     * a per-connection `WebSocketPair` (no broadcast).
     */
    webSocketHub?: (env: Env) => DurableObjectNamespaceLike
  },
): {
  fetch(request: Request, env: Env, ctx: ExecutionContext): MaybePromise<Response>
  scheduled?(controller: ScheduledController, env: Env, ctx: ExecutionContext): MaybePromise<void>
} {
  const scheduled = options?.scheduled
  const webSocketHub = options?.webSocketHub
  const resolveWs = app.resolveWebSocketUpgrade?.bind(app)
  return {
    fetch: (request, env, ctx) => {
      // The platform's own HTTP parser delimited this body, so the declared Content-Length IS the
      // transport frame rather than a caller's hint - the same guarantee Bun's native routes and
      // `Deno.serve` carry, and the reason `serve(request, env, ctx)` is a stronger statement about
      // provenance than a bare `app.fetch(req)` (which anyone in-process can call with a hand-built
      // Request). The mark keeps core's JSON lane on the runtime's fused parse instead of copying
      // the body out to recount its bytes. Written as the registered symbol, not an import of
      // `markTrustedBodyFraming`, so this file keeps its no-runtime-edge property: a GET-only edge
      // app must not pull `body.ts` (and `http.ts` behind it) into its bundle for one flag.
      ;(request as unknown as Record<symbol, unknown>)[Symbol.for("nifra.body.trustedFraming")] =
        true
      const platform: Platform<Env> = { env, waitUntil: (promise) => ctx.waitUntil(promise) }
      // WebSocket broadcast on Workers: route upgrades to the hub Durable Object (it holds the
      // connections + runs the app's pub/sub, so `app.publish` reaches every client). The hub itself
      // resolves the route and rejects non-WS paths. See `@nifrajs/workers`' `createWebSocketHub`.
      if (
        webSocketHub !== undefined &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        const ns = webSocketHub(env)
        return ns.get(ns.idFromName(NIFRA_WS_HUB_ID)).fetch(request)
      }
      // Workers WebSockets: a WS upgrade for a registered route becomes a `WebSocketPair` + a 101.
      // Feature-detected, so non-Workers edge runtimes (which lack `WebSocketPair` - e.g. Deno Deploy
      // uses `@nifrajs/deno`'s `Deno.upgradeWebSocket`) simply fall through to the normal `fetch`.
      const Pair = (globalThis as { WebSocketPair?: WebSocketPairCtor }).WebSocketPair
      if (resolveWs !== undefined && Pair !== undefined) {
        const accept = (outcome: WebSocketUpgradeOutcome): MaybePromise<Response> => {
          if (outcome.kind === "pass") return app.fetch(request, platform)
          if (outcome.kind === "reject") return outcome.response
          const pair = new Pair()
          const server = pair[1]
          server.accept()
          // The outcome carries the installed runtime's `attach`, so `toFetchHandler` (a standalone
          // function, no access to the app's private runtime) wires the socket without a static WS import.
          outcome.attach(server, outcome.handler, outcome.data, {
            openNow: true,
            pubsub: outcome.pubsub,
          })
          // `webSocket` is a Workers-only `ResponseInit` field (absent from the standard type), and a
          // 101 status is only valid on the Workers runtime - both gated by the `Pair` feature check.
          return new Response(null, { status: 101, webSocket: pair[0] } as unknown as ResponseInit)
        }
        const out = resolveWs(request, platform)
        return out instanceof Promise ? out.then(accept) : accept(out)
      }
      return app.fetch(request, platform)
    },
    ...(scheduled !== undefined
      ? {
          scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) =>
            scheduled(controller, { env, waitUntil: (promise) => ctx.waitUntil(promise) }),
        }
      : {}),
  }
}
