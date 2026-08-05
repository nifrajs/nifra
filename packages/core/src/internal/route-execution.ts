/**
 * What a compiled route IS, and the registration-time decision that produces it.
 *
 * ## Why this is not in the server kernel
 *
 * `compileExecutionPlan` is BOOT work: it runs from `register`/`registerBatch`, both gated by
 * `assertConfigurable`, so nothing here is reachable once the server is serving. Moving it costs the
 * request path nothing - per-request code still calls the same frozen `run` closure it always did.
 *
 * ## Why `internal/`
 *
 * These types are the engine's vocabulary, not the package's API. They lived in `server.ts`, which IS
 * published as `./server`, so every attempt to split the kernel had the same choice: export the engine's
 * internals as public types, or not split. `internal/` is not a published subpath, so this moves the
 * vocabulary somewhere it can be shared without becoming API. That is the step that unblocks the rest.
 *
 * The `Server` import is type-only and erased, so there is no runtime cycle back into the kernel.
 */
import type { RequestBudget } from "../budget.ts"
import type { StandardSchemaV1 } from "../schema/standard.ts"
import type { Platform, RouteSchema } from "../server/context.ts"
import type { ResolvedIdempotency } from "../server/idempotency-lane.ts"
import type { ResolvedEffectLedger } from "../server/ledger-lane.ts"
import type { Registry } from "../server/registry.ts"
import type { ResponseContractRuntime } from "../server/response-contract-lane.ts"
import type { HandlerResult } from "../server/runtime-core.ts"
import type { CtxSet, MaybePromise, RawContext, RequestSource, Server } from "../server/server.ts"

export type InternalHandler = (ctx: RawContext) => MaybePromise<HandlerResult>

/** A `derive` computes per-request context extensions; stored path-erased. */
export type RawDerive = (ctx: RawContext) => MaybePromise<object>
export type RawBeforeHandle = (ctx: RawContext) => MaybePromise<unknown>
export type RawAfterHandle = (result: unknown, ctx: RawContext) => MaybePromise<unknown>
export type RawErrorHandler = (error: unknown, ctx: RawContext) => MaybePromise<unknown>
export type RawAround = <T>(ctx: RawContext, next: () => MaybePromise<T>) => MaybePromise<T>

export type RouteExecutionRunner = <T, R extends Registry, Ctx>(
  runtime: Server<R, Ctx>,
  entry: RouteEntry,
  source: RequestSource,
  params: Record<string, string>,
  search: string | undefined,
  signal: AbortSignal,
  budget: RequestBudget,
  platform: Platform | undefined,
  finalize: (result: unknown, set: CtxSet) => T,
  wrapResponse: (response: Response) => T,
) => MaybePromise<T>

export type ContextRouteRunner = <T, R extends Registry, Ctx>(
  runtime: Server<R, Ctx>,
  entry: RouteEntry,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet) => T,
  wrapResponse: (response: Response) => T,
) => MaybePromise<T>

/** Registration-compiled route behavior. Every adapter invokes the same runner; the optional fused
 * renderer is only a response-format specialization of that same selected route semantics. */
export interface RouteExecutionPlan {
  readonly run: RouteExecutionRunner
  readonly fusedWeb: FusedWebRunner | undefined
  readonly fusedBody: FusedBodyRunner | undefined
  /** Which builder produced {@link fusedWeb} - a merge rebinds the closure to the executing server
   * and must rebuild it with the SAME semantics (a query-fused route rebuilt as bare would skip its
   * validation). `undefined` iff `fusedWeb` is. */
  readonly fusedLane: "bare" | "body" | "query" | undefined
}

export interface RouteEntry {
  readonly handler: InternalHandler
  readonly schema: RouteSchema | undefined
  /** Resolved idempotency config; `undefined` = off (the dedupe lane is never entered). */
  readonly idempotent: ResolvedIdempotency | undefined
  /** Resolved effect-ledger wiring; `undefined` = off (no per-request ledger, no settle step). */
  readonly ledgered: ResolvedEffectLedger | undefined
  /** The installed response-contract runtime paired with this route's declared schema, resolved once
   * at registration; `undefined` = not checked (the default, and the only state in which the route can
   * still take the fused/native lanes). */
  readonly responseContract:
    | { readonly runtime: ResponseContractRuntime; readonly schema: StandardSchemaV1 }
    | undefined
  /** Per-request context extensions captured at registration (order-scoped). */
  readonly derives: ReadonlyArray<RawDerive>
  /** Static context extensions captured at registration. */
  readonly decorations: Record<PropertyKey, unknown>
  /** Whether {@link decorations} has any keys - precomputed so the hot path skips a no-op
   * `Object.assign` on the (common) no-decoration route. */
  readonly hasDecorations: boolean
  /** Lifecycle hooks captured at registration (order-scoped). */
  readonly beforeHandle: ReadonlyArray<RawBeforeHandle>
  readonly afterHandle: ReadonlyArray<RawAfterHandle>
  readonly onError: ReadonlyArray<RawErrorHandler>
  /** Wraps the matched route lifecycle. Empty for the common no-around path. */
  readonly around: ReadonlyArray<RawAround>
  /** The single immutable execution decision consumed by portable, Node-direct, and Bun-native paths. */
  readonly execution: RouteExecutionPlan
}

/** The fused Web lane: same inputs `routeAndRun` would hand the generic path, a `Response` out. */
export type FusedWebRunner = (
  source: RequestSource,
  params: Record<string, string>,
  search: string | undefined,
  signal: AbortSignal,
  budget: RequestBudget,
  platform: Platform | undefined,
  nativeContext: boolean,
) => MaybePromise<Response>

/** Registration-compiled body lane. The finalizer receives the live context so Web can preserve lazy
 * response controls while Node can emit its native outcome directly. */
export type FusedBodyRunner = <T>(
  source: RequestSource,
  params: Record<string, string>,
  search: string | undefined,
  signal: AbortSignal,
  budget: RequestBudget,
  platform: Platform | undefined,
  nativeContext: boolean,
  finalize: (result: unknown, set: CtxSet, ctx: RawContext) => T,
  wrapResponse: (response: Response) => T,
) => MaybePromise<T>
