/**
 * Registration-time route compilation.
 *
 * This module owns the policy decisions that turn a route declaration into the immutable facts the
 * execution-plan builder and the route catalog consume. It deliberately runs only from `Server.register`
 * and `Server.registerBatch`; no function here is reachable from the request path.
 *
 * The public Server remains the fluent registration surface. This module is the deep implementation seam
 * behind that surface: body limits, capability and assurance evidence, optional runtimes, decorations, and
 * lane selection are resolved once, together, so adding a new route policy does not require editing the
 * kernel's dispatch code.
 */
import type { EffectLifecycleObserver } from "../effect-lifecycle.ts"
import { RouteConfigError } from "../errors.ts"
import { type CompiledRoutePattern, compileRoutePattern } from "../router/pattern.ts"
import type { Method } from "../router/router.ts"
import type { StandardSchemaV1 } from "../schema/standard.ts"
import { assertByteLimit } from "../server/body.ts"
import type { RouteSchema } from "../server/context.ts"
import type { IdempotencyRuntime, ResolvedIdempotency } from "../server/idempotency-lane.ts"
import type { EffectLedgerRuntime, ResolvedEffectLedger } from "../server/ledger-lane.ts"
import type { ResponseContractRuntime } from "../server/response-contract-lane.ts"
import {
  CAPABILITY_GUARD,
  type CapabilityUseEvent,
  createCapabilityGuard,
  normalizeRouteCapabilities,
  type RegisteredCapabilityInterceptor,
} from "./capability-runtime.ts"
import {
  type AssuranceDeclaration,
  assuranceDeclarationsOf,
  assuranceEvidenceFor,
  NIFRA_ASSURANCE_IDS,
  validEvidenceId,
} from "./route-assurance.ts"
import type {
  RawAfterHandle,
  RawAround,
  RawBeforeHandle,
  RawDerive,
  RawErrorHandler,
} from "./route-execution.ts"
import { type RouteLaneSelection, selectRouteLanes } from "./route-lanes.ts"

export interface RouteCompilerContext {
  readonly maxBodyBytes: number
  readonly activeAssurance: readonly AssuranceDeclaration[]
  readonly globalAssurance: readonly AssuranceDeclaration[]
  readonly decorations: Record<string, unknown>
  readonly onCapabilityUse: ((event: CapabilityUseEvent) => void) | undefined
  readonly capabilityInterceptors: readonly RegisteredCapabilityInterceptor[]
  readonly capabilityObservers: readonly EffectLifecycleObserver[]
  readonly effectLedgerRuntime: EffectLedgerRuntime | undefined
  readonly idempotencyRuntime: IdempotencyRuntime | undefined
  readonly responseContractRuntime: ResponseContractRuntime | undefined
  readonly derives: readonly RawDerive[]
  readonly beforeHandleHooks: readonly RawBeforeHandle[]
  readonly afterHandleHooks: readonly RawAfterHandle[]
  readonly onErrorHooks: readonly RawErrorHandler[]
  readonly aroundHooks: readonly RawAround[]
  readonly defaultOnValidationError: RouteSchema["onValidationError"] | undefined
}

export interface CompiledRouteOptions {
  readonly pattern: CompiledRoutePattern
  readonly bodyLimit: number | undefined
  readonly capabilities: readonly string[]
  readonly handlerAssurance: readonly AssuranceDeclaration[]
  readonly routeDecorations: Record<PropertyKey, unknown>
  readonly hasDecorations: boolean
  readonly idempotent: ResolvedIdempotency | undefined
  readonly ledgered: ResolvedEffectLedger | undefined
  readonly responseContract:
    | { readonly runtime: ResponseContractRuntime; readonly schema: StandardSchemaV1 }
    | undefined
  readonly lanes: RouteLaneSelection
  readonly routeAssurance: readonly AssuranceDeclaration[]
}

/** Resolve all registration-time policy and lane facts for one route. */
export function compileRouteOptions(
  context: RouteCompilerContext,
  method: Method,
  path: string,
  schema: RouteSchema | undefined,
  handler: (context: never) => unknown,
): CompiledRouteOptions {
  const pattern = compileRoutePattern(path)
  let bodyLimit: number | undefined = context.maxBodyBytes
  const invalidBodyLimit = (message: string): never => {
    throw new RouteConfigError("INVALID_BODY_LIMIT", `route ${method} ${path}: ${message}`)
  }
  if (schema?.bodyLimitReason !== undefined && schema.bodyLimit !== "unlimited") {
    invalidBodyLimit('bodyLimitReason is only valid with bodyLimit: "unlimited"')
  }
  if (schema?.bodyLimit === "unlimited") {
    if (typeof schema.bodyLimitReason !== "string" || schema.bodyLimitReason.trim().length === 0) {
      invalidBodyLimit('bodyLimit: "unlimited" requires a non-empty bodyLimitReason')
    }
    if (schema.body !== undefined) {
      invalidBodyLimit('bodyLimit: "unlimited" cannot be used with a body schema; use a finite cap')
    }
    if (schema.idempotency !== undefined) {
      invalidBodyLimit('bodyLimit: "unlimited" cannot be used with idempotency')
    }
    bodyLimit = undefined
  } else if (schema?.bodyLimit !== undefined) {
    try {
      assertByteLimit(schema.bodyLimit, "route bodyLimit")
    } catch {
      invalidBodyLimit('bodyLimit must be a non-negative safe integer or "unlimited"')
    }
    bodyLimit = schema.bodyLimit
  }

  const capabilities = normalizeRouteCapabilities(schema?.capabilities)
  const handlerAssurance = assuranceDeclarationsOf(handler as unknown as object)
  const invalidHandlerScope = handlerAssurance.find((declaration) => declaration.scope !== "plugin")
  if (invalidHandlerScope !== undefined) {
    throw new RouteConfigError(
      "INVALID_ASSURANCE",
      `route handler assurance must use plugin scope (received ${invalidHandlerScope.scope})`,
    )
  }

  const authenticated = assuranceEvidenceFor(
    [...context.activeAssurance, ...handlerAssurance, ...context.globalAssurance],
    method,
    path,
  ).some((evidence) => evidence.id === NIFRA_ASSURANCE_IDS.AUTHENTICATED)
  const routeDecorations: Record<PropertyKey, unknown> = { ...context.decorations }
  if (capabilities.length > 0) {
    routeDecorations[CAPABILITY_GUARD] = createCapabilityGuard(
      capabilities,
      method,
      path,
      context.onCapabilityUse,
      context.idempotencyRuntime?.trackEffect,
      Object.freeze([...context.capabilityInterceptors]),
      Object.freeze([...context.capabilityObservers]),
    )
  }
  const hasDecorations = Reflect.ownKeys(routeDecorations).length > 0

  if (schema?.idempotency !== undefined && context.idempotencyRuntime === undefined) {
    throw new RouteConfigError(
      "INVALID_IDEMPOTENCY",
      "route declares idempotency but the idempotency plugin is not installed; add .use(idempotency())",
    )
  }
  const idempotent = context.idempotencyRuntime?.resolve(
    schema,
    authenticated,
    context.maxBodyBytes,
  )
  const ledgered = context.effectLedgerRuntime?.resolve(capabilities, method, path)
  const contracted =
    context.responseContractRuntime !== undefined && schema?.response !== undefined
      ? { runtime: context.responseContractRuntime, schema: schema.response }
      : undefined
  const lanes = selectRouteLanes({
    schema,
    hasIdempotency: idempotent !== undefined,
    hasLedger: ledgered !== undefined,
    hasResponseContract: contracted !== undefined,
    hasDecorations,
    derives: context.derives.length,
    beforeHandle: context.beforeHandleHooks.length,
    afterHandle: context.afterHandleHooks.length,
    onError: context.onErrorHooks.length,
    around: context.aroundHooks.length,
    defaultOnValidationError: context.defaultOnValidationError !== undefined,
  })

  const routeAssurance: AssuranceDeclaration[] = [...context.activeAssurance, ...handlerAssurance]
  if (contracted?.runtime.mode === "enforce" && schema?.response !== undefined) {
    routeAssurance.push(
      Object.freeze({
        id: NIFRA_ASSURANCE_IDS.RESPONSE_CONTRACT,
        source: "response-contract",
        scope: "plugin",
      }),
    )
  }
  for (const id of schema?.assurance ?? []) {
    if (!validEvidenceId(id)) {
      throw new Error(
        `route assurance: invalid evidence id ${JSON.stringify(id)} on ${method} ${path} (use lowercase dot/dash segments)`,
      )
    }
    const declared = { id, source: "declared", scope: "plugin" } as AssuranceDeclaration
    Object.defineProperty(declared, "provenance", {
      value: "declared",
      enumerable: false,
      configurable: false,
      writable: false,
    })
    routeAssurance.push(Object.freeze(declared))
  }
  const unlimitedBody = schema?.bodyLimit === "unlimited"
  if (!unlimitedBody && (schema?.body !== undefined || typeof schema?.bodyLimit === "number")) {
    routeAssurance.push(
      Object.freeze({
        id: NIFRA_ASSURANCE_IDS.BODY_BOUNDED,
        source: "route-schema",
        scope: "plugin",
      }),
    )
  }
  if (schema?.idempotency !== undefined) {
    routeAssurance.push(
      Object.freeze({
        id: NIFRA_ASSURANCE_IDS.IDEMPOTENCY_KEY,
        source: "route-schema",
        scope: "plugin",
      }),
    )
  }

  return {
    pattern,
    bodyLimit,
    capabilities,
    handlerAssurance,
    routeDecorations,
    hasDecorations,
    idempotent,
    ledgered,
    responseContract: contracted,
    lanes,
    routeAssurance: Object.freeze(routeAssurance),
  }
}
