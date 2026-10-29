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
import { assertByteLimit } from "../server/body.ts"
import type { RouteSchema } from "../server/context.ts"
import type { IdempotencyRuntime, ResolvedIdempotency } from "../server/idempotency-lane.ts"
import type { EffectLedgerRuntime, ResolvedEffectLedger } from "../server/ledger-lane.ts"
import { decorationsAssignable } from "../server/request-context.ts"
import type {
  ResponseContractDefinition,
  ResponseContractRuntime,
} from "../server/response-contract-lane.ts"
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
import type { CatalogRoute } from "./route-catalog.ts"
import type {
  RawAfterHandle,
  RawAround,
  RawAuthStage,
  RawBeforeHandle,
  RawDerive,
  RawErrorHandler,
} from "./route-execution.ts"
import { compileRouteExecutionPlan } from "./route-execution.ts"
import { type RouteLaneSelection, selectRouteLanes } from "./route-lanes.ts"
import { compileRouteProgram } from "./route-program.ts"

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
  readonly authStages: readonly RawAuthStage[]
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
    | { readonly runtime: ResponseContractRuntime; readonly definition: ResponseContractDefinition }
    | undefined
  readonly lanes: RouteLaneSelection
  readonly routeAssurance: readonly AssuranceDeclaration[]
  readonly authStages: readonly RawAuthStage[]
  readonly authenticated: boolean
}

const RESPONSE_CONTRACT_EVIDENCE: AssuranceDeclaration = Object.freeze({
  id: NIFRA_ASSURANCE_IDS.RESPONSE_CONTRACT,
  source: "response-contract",
  scope: "plugin",
})

function responseDefinitionOf(
  schema: RouteSchema | undefined,
): ResponseContractDefinition | undefined {
  return schema?.response !== undefined || schema?.errors !== undefined
    ? {
        ...(schema.response === undefined ? {} : { response: schema.response }),
        ...(schema.errors === undefined ? {} : { errors: schema.errors }),
      }
    : undefined
}

/**
 * Recompile a route another server compiled, under the response contract and effect ledger the
 * adopting server installed and the route's own server did not. Both only add a check or a record,
 * so a merged route can never serve more than it did standalone - and without this, the same
 * `.use()` covered a `group()` route but not a `merge()`d one. A route that already resolved its
 * own contract or ledger keeps it.
 */
export function adoptRouteRuntimes(
  route: CatalogRoute,
  responseContractRuntime: ResponseContractRuntime | undefined,
  effectLedgerRuntime: EffectLedgerRuntime | undefined,
): CatalogRoute {
  const { entry, descriptor } = route
  const definition =
    entry.responseContract === undefined && responseContractRuntime !== undefined
      ? responseDefinitionOf(entry.schema)
      : undefined
  const ledgered =
    entry.ledgered ??
    effectLedgerRuntime?.resolve(descriptor.capabilities ?? [], route.method, route.path)
  if (definition === undefined && ledgered === entry.ledgered) return route
  const responseContract =
    definition === undefined || responseContractRuntime === undefined
      ? entry.responseContract
      : { runtime: responseContractRuntime, definition }
  // Either runtime rules out every fused lane, so the route needs only the generic plan here - and
  // nothing the source server's validation-error default decided about fusion can matter any more.
  const lanes = selectRouteLanes({
    schema: entry.schema,
    hasAuth: entry.authStages.length > 0,
    hasIdempotency: entry.idempotent !== undefined,
    hasLedger: ledgered !== undefined,
    hasResponseContract: responseContract !== undefined,
    derives: entry.derives.length,
    beforeHandle: entry.beforeHandle.length,
    afterHandle: entry.afterHandle.length,
    onError: entry.onError.length,
    around: entry.around.length,
    defaultOnValidationError: false,
  })
  const program = compileRouteProgram({
    schema: entry.schema,
    handler: entry.handler,
    derives: entry.derives,
    authStages: entry.authStages,
    beforeHandle: entry.beforeHandle,
    afterHandle: entry.afterHandle,
    onError: entry.onError,
    decorations: entry.decorations,
    hasDecorations: entry.hasDecorations,
    bodySchema: entry.schema?.body,
    bodyLimit: entry.bodyLimit,
    responseContract,
  })
  const execution = compileRouteExecutionPlan({
    lane: lanes.lane,
    contextless: false,
    hasAround: entry.around.length > 0,
    hasLedger: ledgered !== undefined,
    fusedWeb: undefined,
    fusedBody: undefined,
    fusedLane: undefined,
  })
  const enforced = definition !== undefined && responseContractRuntime?.mode === "enforce"
  return {
    ...route,
    entry: {
      ...entry,
      ledgered,
      responseContract,
      lifecycleHookLane: undefined,
      execution,
      program,
    },
    descriptor:
      definition === undefined || responseContractRuntime === undefined
        ? descriptor
        : { ...descriptor, responseContract: responseContractRuntime.mode },
    assurance: enforced
      ? Object.freeze([...route.assurance, RESPONSE_CONTRACT_EVIDENCE])
      : route.assurance,
  }
}

/** Resolve all registration-time policy and lane facts for one route. */
export function compileRouteOptions(
  context: RouteCompilerContext,
  method: string,
  path: string,
  schema: RouteSchema | undefined,
  handler: (context: never) => unknown,
): CompiledRouteOptions {
  const pattern = compileRoutePattern(path)
  let bodyLimit: number | undefined = context.maxBodyBytes
  const invalidBodyLimit = (message: string): never => {
    throw new RouteConfigError("INVALID_BODY_LIMIT", `route ${method} ${path}: ${message}`)
  }
  if (schema?.wire !== undefined && schema.wire !== "raw") {
    throw new RouteConfigError("INVALID_WIRE", `route ${method} ${path}: wire must be "raw"`)
  }
  if (schema?.wire === "raw" && schema.body !== undefined) {
    throw new RouteConfigError(
      "INVALID_WIRE",
      `route ${method} ${path}: wire: "raw" cannot be combined with a body schema`,
    )
  }
  if (
    schema?.validationOrder !== undefined &&
    schema.validationOrder !== "validate-before-auth" &&
    schema.validationOrder !== "auth-before-validation"
  ) {
    throw new RouteConfigError(
      "INVALID_VALIDATION_ORDER",
      `route ${method} ${path}: validationOrder is invalid`,
    )
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
  const handlerAssurance = assuranceDeclarationsOf(handler as object)
  const invalidHandlerScope = handlerAssurance.find((declaration) => declaration.scope !== "plugin")
  if (invalidHandlerScope !== undefined) {
    throw new RouteConfigError(
      "INVALID_ASSURANCE",
      `route handler assurance must use plugin scope (received ${invalidHandlerScope.scope})`,
    )
  }

  const authenticated =
    context.authStages.length > 0 ||
    assuranceEvidenceFor(
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
  const responseDefinition = responseDefinitionOf(schema)
  const contracted =
    context.responseContractRuntime !== undefined && responseDefinition !== undefined
      ? { runtime: context.responseContractRuntime, definition: responseDefinition }
      : undefined
  const lanes = selectRouteLanes({
    schema,
    hasAuth: context.authStages.length > 0,
    hasIdempotency: idempotent !== undefined,
    hasLedger: ledgered !== undefined,
    hasResponseContract: contracted !== undefined,
    decorationsAssignable: !hasDecorations || decorationsAssignable(routeDecorations),
    derives: context.derives.length,
    beforeHandle: context.beforeHandleHooks.length,
    afterHandle: context.afterHandleHooks.length,
    onError: context.onErrorHooks.length,
    around: context.aroundHooks.length,
    defaultOnValidationError: context.defaultOnValidationError !== undefined,
  })

  const routeAssurance: AssuranceDeclaration[] = [...context.activeAssurance, ...handlerAssurance]
  if (contracted?.runtime.mode === "enforce") routeAssurance.push(RESPONSE_CONTRACT_EVIDENCE)
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
  if (context.authStages.length > 0) {
    // `authenticate()` is an actual runtime enforcement stage, not a route assertion. Publish its
    // proof directly so a core-authenticated route cannot accidentally become assurance
    // classification-only when it is not using an integration plugin such as better-auth.
    routeAssurance.push(
      Object.freeze({
        id: NIFRA_ASSURANCE_IDS.AUTHENTICATED,
        source: "nifra.authenticate",
        scope: "plugin",
        provenance: "runtime" as const,
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
    authStages: Object.freeze([...context.authStages]),
    authenticated,
  }
}
