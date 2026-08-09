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
import type { RequestLedger } from "../ledger.ts"
import type { StandardSchemaV1 } from "../schema/standard.ts"
import type { Platform, RouteSchema } from "../server/context.ts"
import type { ResolvedIdempotency } from "../server/idempotency-lane.ts"
import type { EffectLedgerRuntime, ResolvedEffectLedger } from "../server/ledger-lane.ts"
import type { Registry } from "../server/registry.ts"
import { RequestContext } from "../server/request-context.ts"
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
  nativeContext: boolean,
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

/** The kernel's private execution surface, mirrored structurally. The runner methods are private on
 * `Server` by design; this compiler lives outside the class, so it reaches them through a type-level
 * mirror of their exact signatures. The `as unknown as` at each use is erased by compilation - the
 * request path calls the kernel methods directly, with no adapter object and no extra hop. The mirror
 * is not exported: it is this module's view of the kernel, not vocabulary anyone else may bind to. */
interface RouteExecutionRuntime {
  runContextlessBare<T>(
    entry: RouteEntry,
    source: RequestSource,
    params: Record<string, string>,
    search: string | undefined,
    signal: AbortSignal,
    budget: RequestBudget,
    platform: Platform | undefined,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T>
  runBare<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T>
  runBodyOnly<T>(
    entry: RouteEntry,
    source: RequestSource,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T>
  runQueryOnly<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T>
  runLifecycleHooks<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T>
  runLifecycleQuery<T>(
    entry: RouteEntry,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T>
  runLifecycleBody<T>(
    entry: RouteEntry,
    source: RequestSource,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T>
  runLifecycleBodyQuery<T>(
    entry: RouteEntry,
    source: RequestSource,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T>
  runLifecycle<T>(
    entry: RouteEntry,
    source: RequestSource,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T>
  runWithAround<T>(
    entry: RouteEntry,
    ctx: RawContext,
    run: () => MaybePromise<T>,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response) => T,
  ): MaybePromise<T>
  readonly maxBodyBytes: number
  readonly effectLedgerRuntime: EffectLedgerRuntime | undefined
  readonly logger: {
    error(message: string, fields: { method: string; path: string; name: string }): void
  }
}

export type RouteExecutionLane = "bare" | "body" | "query" | "lifecycle"
export type LifecycleExecutionLane = "hooks" | "query" | "body" | "body-query" | undefined

/** Compile the one immutable route decision at registration time. The request path only invokes the
 * selected closure; it never repeats this eligibility ladder. The closures reach the kernel's private
 * runners through the {@link RouteExecutionRuntime} mirror - a compile-time cast, not a dispatch
 * object, so the emitted request path is a direct method call on the server. */
export function compileRouteExecutionPlan(options: {
  readonly lane: RouteExecutionLane
  readonly contextless: boolean
  readonly hasAround: boolean
  readonly hasLedger: boolean
  readonly lifecycleLane: LifecycleExecutionLane
  readonly fusedWeb: FusedWebRunner | undefined
  readonly fusedBody: FusedBodyRunner | undefined
  readonly fusedLane: "bare" | "body" | "query" | undefined
}): RouteExecutionPlan {
  const { lane, contextless, hasAround, hasLedger, lifecycleLane, fusedWeb, fusedBody, fusedLane } =
    options

  if (contextless) {
    const run: RouteExecutionRunner = (
      runtime,
      entry,
      source,
      params,
      search,
      signal,
      budget,
      platform,
      _nativeContext,
      finalize,
      wrapResponse,
    ) =>
      (runtime as unknown as RouteExecutionRuntime).runContextlessBare(
        entry,
        source,
        params,
        search,
        signal,
        budget,
        platform,
        finalize,
        wrapResponse,
      )
    return Object.freeze({ run, fusedWeb, fusedBody, fusedLane })
  }

  let inner: ContextRouteRunner
  switch (lane) {
    case "bare":
      inner = (runtime, entry, _source, ctx, finalize, wrapResponse) =>
        (runtime as unknown as RouteExecutionRuntime).runBare(entry, ctx, finalize, wrapResponse)
      break
    case "body":
      inner = (runtime, entry, source, ctx, finalize, wrapResponse) =>
        (runtime as unknown as RouteExecutionRuntime).runBodyOnly(
          entry,
          source,
          ctx,
          finalize,
          wrapResponse,
        )
      break
    case "query":
      inner = (runtime, entry, _source, ctx, finalize, wrapResponse) =>
        (runtime as unknown as RouteExecutionRuntime).runQueryOnly(
          entry,
          ctx,
          finalize,
          wrapResponse,
        )
      break
    default:
      switch (lifecycleLane) {
        case "hooks":
          inner = (runtime, entry, _source, ctx, finalize, wrapResponse) =>
            (runtime as unknown as RouteExecutionRuntime).runLifecycleHooks(
              entry,
              ctx,
              finalize,
              wrapResponse,
            )
          break
        case "query":
          inner = (runtime, entry, _source, ctx, finalize, wrapResponse) =>
            (runtime as unknown as RouteExecutionRuntime).runLifecycleQuery(
              entry,
              ctx,
              finalize,
              wrapResponse,
            )
          break
        case "body":
          inner = (runtime, entry, source, ctx, finalize, wrapResponse) =>
            (runtime as unknown as RouteExecutionRuntime).runLifecycleBody(
              entry,
              source,
              ctx,
              finalize,
              wrapResponse,
            )
          break
        case "body-query":
          inner = (runtime, entry, source, ctx, finalize, wrapResponse) =>
            (runtime as unknown as RouteExecutionRuntime).runLifecycleBodyQuery(
              entry,
              source,
              ctx,
              finalize,
              wrapResponse,
            )
          break
        default:
          inner = (runtime, entry, source, ctx, finalize, wrapResponse) =>
            (runtime as unknown as RouteExecutionRuntime).runLifecycle(
              entry,
              source,
              ctx,
              finalize,
              wrapResponse,
            )
      }
  }

  const execute: ContextRouteRunner = hasAround
    ? (runtime, entry, source, ctx, finalize, wrapResponse) =>
        (runtime as unknown as RouteExecutionRuntime).runWithAround(
          entry,
          ctx,
          () => inner(runtime, entry, source, ctx, finalize, wrapResponse),
          finalize,
          wrapResponse,
        )
    : inner

  const run: RouteExecutionRunner = (
    runtime,
    entry,
    source,
    params,
    search,
    signal,
    budget,
    platform,
    nativeContext,
    finalize,
    wrapResponse,
  ) => {
    const server = runtime as unknown as RouteExecutionRuntime
    const ctx = nativeContext
      ? RequestContext.native(source, params, search, server.maxBodyBytes, platform)
      : new RequestContext(source, params, search, signal, budget, platform, server.maxBodyBytes)
    let ledger: RequestLedger | undefined
    // The runtime is always present when a route resolved a ledger (enforced at registration).
    const ledgerRuntime = server.effectLedgerRuntime
    if (hasLedger && ledgerRuntime !== undefined) {
      const resolved = entry.ledgered as ResolvedEffectLedger
      ledger = ledgerRuntime.create(resolved)
      ledgerRuntime.attach(ctx, ledger)
    }
    let outcome = execute(runtime, entry, source, ctx, finalize, wrapResponse)
    if (ledger !== undefined && ledgerRuntime !== undefined) {
      const active = ledger
      const resolved = entry.ledgered as ResolvedEffectLedger
      outcome = (outcome instanceof Promise ? outcome : Promise.resolve(outcome)).then((value) =>
        ledgerRuntime.settle(active, resolved, value, (fields) =>
          server.logger.error("effect ledger sink failed", fields),
        ),
      )
    }
    return outcome
  }
  return Object.freeze({ run, fusedWeb, fusedBody, fusedLane })
}

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
  /** Registration-specialized hook shape for the common derive + before middleware route. */
  readonly lifecycleHookLane: "derive-before" | undefined
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
