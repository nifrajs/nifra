/**
 * Registration-time route-lane selection.
 *
 * A route's lane is a property of its registered shape, not of an individual request. Keeping this
 * decision in a small internal module gives the server kernel one vocabulary for
 * bare/body/query/input/lifecycle execution. This module is never called from the request path. The
 * returned booleans are consumed by the existing compiled execution plan and fused
 * builders; no adapter or extra dispatch hop is introduced at runtime.
 */
import type { RouteSchema } from "../server/context.ts"
import type { LifecycleExecutionLane, RouteExecutionLane } from "./route-execution.ts"

export interface RouteLaneSelection {
  readonly bare: boolean
  readonly fusedQuery: boolean
  readonly bodyOnly: boolean
  readonly fusedBody: boolean
  readonly lane: RouteExecutionLane
  readonly lifecycleLane: LifecycleExecutionLane
  readonly lifecycleHookLane: "hooks" | undefined
  readonly fusedLane: "bare" | "body" | "query" | "inputs" | "hooks" | undefined
}

export function selectRouteLanes(options: {
  readonly schema: RouteSchema | undefined
  readonly hasAuth?: boolean
  readonly hasIdempotency: boolean
  readonly hasLedger: boolean
  readonly hasResponseContract: boolean
  /** False when a decoration cannot be merged into the context, which keeps the fused hook lanes off. */
  readonly decorationsAssignable?: boolean
  readonly derives: number
  readonly beforeHandle: number
  readonly afterHandle: number
  readonly onError: number
  readonly around: number
  readonly defaultOnValidationError: boolean
}): RouteLaneSelection {
  const {
    schema,
    hasIdempotency,
    hasLedger,
    hasResponseContract,
    decorationsAssignable = true,
    derives,
    beforeHandle,
    afterHandle,
    onError,
    around,
    defaultOnValidationError,
  } = options

  const authBeforeValidation =
    options.hasAuth === true || schema?.validationOrder === "auth-before-validation"
  // Narrow body/query runners handle simple shapes; the shared input lane composes schemas.
  const plain = schema?.headers === undefined && schema?.cookies === undefined
  const noParams = schema?.params === undefined
  const hasInputSchema =
    schema?.headers !== undefined ||
    schema?.cookies !== undefined ||
    schema?.params !== undefined ||
    schema?.body !== undefined ||
    schema?.query !== undefined

  const bare =
    !authBeforeValidation &&
    plain &&
    noParams &&
    schema?.body === undefined &&
    schema?.query === undefined &&
    !hasIdempotency &&
    !hasLedger &&
    !hasResponseContract &&
    derives === 0 &&
    beforeHandle === 0 &&
    afterHandle === 0 &&
    onError === 0

  // A route whose only input stages are path params and/or a query schema can fuse too: validate +
  // handler + respond collapse into one closure with no lifecycle promise on the sync path. The guards
  // mirror the query lane below PLUS everything the fused dispatch skips: around hooks, the
  // idempotency/ledger wrappers, and validation-error recovery (schema or server default).
  const fusedQuery =
    !bare &&
    !authBeforeValidation &&
    !hasResponseContract &&
    (schema?.query !== undefined || schema?.params !== undefined) &&
    schema.body === undefined &&
    plain &&
    schema?.onValidationError === undefined &&
    !defaultOnValidationError &&
    !hasIdempotency &&
    !hasLedger &&
    derives === 0 &&
    beforeHandle === 0 &&
    afterHandle === 0 &&
    onError === 0 &&
    around === 0

  const bodyOnly =
    !authBeforeValidation &&
    !hasResponseContract &&
    schema?.body !== undefined &&
    schema.query === undefined &&
    plain &&
    derives === 0 &&
    beforeHandle === 0 &&
    afterHandle === 0 &&
    onError === 0

  const fusedBody =
    !bare &&
    !authBeforeValidation &&
    bodyOnly &&
    schema.onValidationError === undefined &&
    !defaultOnValidationError &&
    !hasIdempotency &&
    !hasLedger &&
    around === 0

  // The shared input runner handles every ordinary validation shape, including body+query and
  // params+headers+cookies combinations. It also carries lifecycle and error hooks; only recovery
  // callbacks or outer wrappers that observe the stage sequence need the general program.
  const fusedInputs =
    hasInputSchema &&
    !authBeforeValidation &&
    !hasResponseContract &&
    schema.onValidationError === undefined &&
    !defaultOnValidationError &&
    !hasIdempotency &&
    !hasLedger &&
    decorationsAssignable &&
    around === 0

  // The idempotency gate lives in the general program, so an idempotent route always runs it.
  const lane: RouteExecutionLane =
    authBeforeValidation || hasIdempotency
      ? "lifecycle"
      : bare
        ? "bare"
        : bodyOnly && (noParams || fusedBody)
          ? "body"
          : !hasResponseContract &&
              schema?.body === undefined &&
              schema?.query !== undefined &&
              noParams &&
              plain &&
              derives === 0 &&
              beforeHandle === 0 &&
              afterHandle === 0 &&
              onError === 0
            ? "query"
            : "lifecycle"

  // Select the lifecycle stage shape at registration so the request path never re-checks which input
  // schemas or hook phases are present.
  const lifecycleLane: LifecycleExecutionLane =
    lane !== "lifecycle" || !plain
      ? undefined
      : schema?.body !== undefined
        ? schema.query !== undefined
          ? "body-query"
          : "body"
        : schema?.query !== undefined
          ? "query"
          : "hooks"

  // A route with lifecycle hooks and no validated inputs uses the same compiled hook chain. Input
  // routes use `fusedInputs` above, including when their hooks run after validation.
  const hookCount = derives + beforeHandle + afterHandle
  const lifecycleHookLane =
    lane === "lifecycle" &&
    !authBeforeValidation &&
    !hasResponseContract &&
    decorationsAssignable &&
    !hasIdempotency &&
    !hasLedger &&
    schema?.onValidationError === undefined &&
    !defaultOnValidationError &&
    plain &&
    schema?.body === undefined &&
    (hookCount > 0 || onError > 0) &&
    around === 0
      ? "hooks"
      : undefined

  return {
    bare,
    fusedQuery,
    bodyOnly,
    fusedBody,
    lane,
    lifecycleLane,
    lifecycleHookLane,
    fusedLane:
      around === 0
        ? fusedQuery
          ? "query"
          : fusedBody
            ? "body"
            : bare
              ? "bare"
              : fusedInputs
                ? "inputs"
                : lifecycleHookLane
        : undefined,
  }
}
