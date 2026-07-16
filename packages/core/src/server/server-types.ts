/**
 * Public API-surface types for the server: construction options, the capacity-admission contract,
 * route/tool/MCP descriptors, and the middleware bundle shape. Pure types (no runtime), split out of
 * the server kernel so the descriptor/option vocabulary is one file, distinct from the engine.
 */
import type { CapabilityUseEvent } from "../internal/capability-runtime.ts"
import type { AssuranceEvidence } from "../internal/route-assurance.ts"
import type { Method } from "../router/router.ts"
import type { Context, Platform, RouteSchema } from "./context.ts"
import type { Logger } from "./logger.ts"
import type { MaybePromise, OnRequestResult } from "./server.ts"

/**
 * The outcome of a capacity-admission decision. `admitted` requests carry a `release` the server calls
 * exactly once when the response is finalized; a shed request carries a ready `429` Response.
 */
export type AdmissionDecision =
  | { readonly admitted: true; release(): void }
  | { readonly admitted: false; readonly response: Response }

/**
 * A capacity-admission gate. Decides, per request, whether the instance has capacity to run it now -
 * bounding *concurrency*, which rate limits (frequency) and deadlines (duration) do not. Provide an
 * implementation (see `@nifrajs/middleware`'s `createAdmissionController`) as {@link ServerOptions.admission}.
 *
 * Enabling it trades the fused native-route lane for native matching + this gate (the gate cannot be a
 * per-request `onRequest` hook without disabling native routes entirely); when unset, the request path
 * is untouched.
 */
export interface AdmissionController {
  admit(req: Request): AdmissionDecision | Promise<AdmissionDecision>
}

export interface ServerOptions {
  /**
   * Max request body size (bytes), enforced **only when a route declares a body schema** - the cap
   * lives in the schema-validated read path. Default 1_000_000.
   *
   * A route WITHOUT a body schema (raw body, file upload, BYO-validation) that reads `c.req` directly
   * is not auto-bounded - use **`c.boundedBody(maxBytes?)`** / **`c.boundedJson(maxBytes?)`**, which
   * apply this same cap (override per route by passing `maxBytes` - larger for an upload endpoint,
   * smaller to tighten one).
   */
  readonly maxBodyBytes?: number
  /** Max inbound WebSocket message size (bytes) when `listen()`ing on Bun - frames over this are rejected
   * by the runtime before reaching your handler (so a huge frame can't be JSON-parsed into memory).
   * Default: `maxBodyBytes` (1 MB). */
  readonly wsMaxPayloadBytes?: number
  /** Per-request timeout (ms): a slower request gets a 503 and `ctx.signal` aborts. 0 disables (default). */
  readonly requestTimeoutMs?: number
  /**
   * Admit the public `x-nifra-deadline` header and let it shorten local work. Disabled by default:
   * services that participate in trusted cross-service deadline propagation opt in explicitly,
   * while ordinary/public HTTP routes pay no header-admission tax and ignore hostile client values.
   */
  readonly acceptInboundDeadlines?: boolean
  /**
   * Maximum time accepted from an inbound `x-nifra-deadline`, in milliseconds. An incoming absolute
   * deadline may shorten this cap (and `requestTimeoutMs`, when configured), never extend it.
   * Default 30_000; applies only when `acceptInboundDeadlines` is enabled and the header is present.
   */
  readonly maxInboundDeadlineMs?: number
  /** When `listen()`ing, install SIGTERM/SIGINT handlers that gracefully `stop()`. Default false. */
  readonly gracefulSignals?: boolean
  /**
   * Capacity-admission gate (see {@link AdmissionController}). Bounds concurrent in-flight work so a
   * healthy instance sheds load (`429` + `Retry-After`) instead of accepting more than it can finish.
   * Off by default. Enabling it disables the fused native-route fast path (requests route through the
   * shared matched lane where the gate runs); when unset, the request path pays nothing.
   */
  readonly admission?: AdmissionController
  /**
   * Optional token-only observation hook called by `useCapability(c, id)`. It receives no request,
   * parameters, body, tenant, or values. Routes without capability declarations keep the old hot path.
   */
  readonly onCapabilityUse?: (event: CapabilityUseEvent) => void
  /** Structured logger for framework events (redacts secrets). Default: JSON to stderr. */
  readonly logger?: Logger
  /**
   * App-wide fallback fired when a route **without its own `onValidationError`** fails body/query
   * validation. Same contract as the per-route hook (`(issues, ctx, kind) => Response | repaired-value |
   * undefined`): a route's own hook takes precedence, and a route can fall through to the plain `422` by
   * returning `undefined`. Use it for one app-wide error envelope (like tRPC's `errorFormatter` /
   * Fastify's `setErrorHandler`) instead of repeating a formatter per route.
   */
  readonly onValidationError?: RouteSchema["onValidationError"]
}

/**
 * MCP tool safety hints, surfaced in `tools/list`, that tell an agent how risky a `.tool()` call is - so it
 * can decide whether to auto-invoke or confirm first. All optional; an omitted hint means "unknown". Mirrors
 * the MCP spec's tool `annotations`.
 */
export interface ToolAnnotations {
  /** Human-readable display title for the tool, distinct from the machine `name`. */
  readonly title?: string
  /** The tool does not modify its environment (a pure read). */
  readonly readOnlyHint?: boolean
  /** The tool may perform destructive updates - only meaningful when `readOnlyHint` is not `true`. */
  readonly destructiveHint?: boolean
  /** Repeated calls with the same arguments have no additional effect beyond the first. */
  readonly idempotentHint?: boolean
  /** The tool interacts with external entities (an "open world" beyond this server). */
  readonly openWorldHint?: boolean
}

/**
 * A registered route's public descriptor - method, path, and input schemas. The
 * router trie discards the original patterns, so this flat list is what lets tools
 * (e.g. `toOpenAPI`) enumerate routes after registration.
 */
export interface RouteDescriptor {
  readonly method: Method
  readonly path: string
  readonly schema: RouteSchema | undefined
  /** Effective enforcement evidence, populated only during reflection/introspection. */
  readonly assurance?: readonly AssuranceEvidence[]
  /** Normalized declared effect tokens, populated only when the route declares any. */
  readonly capabilities?: readonly string[]
  readonly tool?: {
    readonly name: string
    readonly description: string
    readonly annotations?: ToolAnnotations
  }
}

/** A message in an MCP prompt's rendered output (see {@link Server.prompt}). */
export interface PromptMessage {
  readonly role: "user" | "assistant"
  readonly content: { readonly type: "text"; readonly text: string }
}

/** One declared argument of an MCP prompt, surfaced in `prompts/list`. */
export interface PromptArgument {
  readonly name: string
  readonly description?: string
  readonly required?: boolean
}

/** An app-declared MCP resource - read-only data an agent can fetch through `nifra mcp`. */
export interface McpResourceDescriptor {
  readonly uri: string
  readonly name: string
  readonly description?: string
  readonly mimeType?: string
  readonly read: () => MaybePromise<string | { readonly text: string; readonly mimeType?: string }>
}

/** An app-declared MCP prompt - a reusable prompt template an agent can fetch through `nifra mcp`. */
export interface McpPromptDescriptor {
  readonly name: string
  readonly description: string
  readonly arguments?: readonly PromptArgument[]
  readonly handler: (args: Record<string, string>) => MaybePromise<readonly PromptMessage[]>
}

/**
 * The handle `listen()` returns - the slice of Bun's server nifra holds and exposes.
 * Declared explicitly (rather than `ReturnType<typeof Bun.serve>`) so the public type
 * surface doesn't leak the ambient `Bun` global into consumers' `.d.ts` resolution.
 */
export interface RunningServer {
  readonly port: number
  readonly hostname: string
  readonly pendingRequests: number
  stop(closeActiveConnections?: boolean): void
}

/**
 * A bundle of lifecycle hooks applied together via {@link Server.use} - the unit
 * `@nifrajs/middleware` ships (cors, security headers, rate-limit). Every hook is
 * optional and wired to its lifecycle point. Middleware is context-agnostic (sees
 * the base `Context`); `use` does no context-type merging - the full type-merging
 * plugin system is deferred, and `.use` is reserved as its future entry point.
 */
export interface Middleware {
  readonly name?: string
  readonly onRequest?: (req: Request, platform?: Platform) => MaybePromise<OnRequestResult>
  readonly around?: <T>(context: Context, next: () => MaybePromise<T>) => MaybePromise<T>
  readonly beforeHandle?: (context: Context) => MaybePromise<unknown>
  readonly afterHandle?: (result: unknown, context: Context) => MaybePromise<unknown>
  readonly onResponse?: (response: Response, req: Request) => MaybePromise<Response>
  readonly onResponseFinalized?: (outcome: ResponseFinalization, req: Request) => MaybePromise<void>
  readonly onError?: (error: unknown, context: Context) => MaybePromise<unknown>
}

/** The terminal response-pipeline outcome observed after every transforming `onResponse` hook. */
export interface ResponseFinalization {
  /** The final response, or the last response available when a transformation failed. */
  readonly response: Response
  /** A response-hook failure. Terminal observers run fail-open before the error is rethrown. */
  readonly error?: unknown
}
