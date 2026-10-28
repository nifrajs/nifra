/**
 * Registration-time route-lane selection.
 *
 * A route's lane is a property of its registered shape, not of an individual request. Keeping this
 * decision in a small internal module gives the server kernel one vocabulary for bare/body/query/
 * lifecycle execution while preserving the important invariant: this module is never called from the
 * request path. The returned booleans are consumed by the existing compiled execution plan and fused
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
  readonly fusedLane: "bare" | "body" | "query" | "hooks" | "body-hooks" | undefined
}

export function selectRouteLanes(options: {
  readonly schema: RouteSchema | undefined
  readonly hasAuth?: boolean
  readonly hasIdempotency: boolean
  readonly hasLedger: boolean
  readonly hasResponseContract: boolean
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
    derives,
    beforeHandle,
    afterHandle,
    onError,
    around,
    defaultOnValidationError,
  } = options

  const authBeforeValidation =
    options.hasAuth === true || schema?.validationOrder === "auth-before-validation"
  // No fused lane validates params, headers, or cookies: any of those schemas keeps the stage runner.
  const plain =
    schema?.params === undefined && schema?.headers === undefined && schema?.cookies === undefined

  const bare =
    !authBeforeValidation &&
    plain &&
    schema?.body === undefined &&
    schema?.query === undefined &&
    !hasIdempotency &&
    !hasLedger &&
    !hasResponseContract &&
    derives === 0 &&
    beforeHandle === 0 &&
    afterHandle === 0 &&
    onError === 0

  // A route whose ONLY lifecycle step is a query schema can fuse too: the parse + validate + handler +
  // respond collapse into one closure with no lifecycle promise on the sync path. The guards mirror the
  // query lane below PLUS everything the fused dispatch skips: around hooks, the idempotency/ledger
  // wrappers, and validation-error recovery (schema or server default) - the fused invalid path is
  // exactly `validationError(issues)`, so any recovery semantics keep the generic lane.
  const fusedQuery =
    !bare &&
    !authBeforeValidation &&
    !hasResponseContract &&
    schema?.query !== undefined &&
    schema.body === undefined &&
    plain &&
    schema.onValidationError === undefined &&
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

  // The idempotency gate lives in the general program, so an idempotent route always runs it.
  const lane: RouteExecutionLane =
    authBeforeValidation || hasIdempotency
      ? "lifecycle"
      : bare
        ? "bare"
        : bodyOnly
          ? "body"
          : !hasResponseContract &&
              schema?.body === undefined &&
              schema?.query !== undefined &&
              plain &&
              derives === 0 &&
              beforeHandle === 0 &&
              afterHandle === 0 &&
              onError === 0
            ? "query"
            : "lifecycle"

  // Lifecycle routes with no params schema are the common middleware shape: derive/before plus an
  // optional query or body schema. Select their complete validation stage at registration so the
  // request path never re-checks params/body presence. Parameter-schema routes retain the generic
  // lifecycle runner until their more involved recovery matrix is selected explicitly.
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

  // A route whose only lifecycle steps are derive, before and after hooks (any number of each, at least
  // one) runs them in one fused closure chain, with the route's decorations and error hooks. Anything
  // that can observe around hooks, a response contract or a validation-error recovery keeps the
  // generic runner. A params, headers or cookies schema
  // routes back to the generic lane because the fused builder has no validation step for them, and a
  // `body` schema is the `body-hooks` lane below because this one does not parse the body.
  const hookCount = derives + beforeHandle + afterHandle
  const lifecycleHookLane =
    lane === "lifecycle" &&
    !authBeforeValidation &&
    !hasResponseContract &&
    !hasIdempotency &&
    !hasLedger &&
    schema?.onValidationError === undefined &&
    !defaultOnValidationError &&
    plain &&
    schema?.body === undefined &&
    hookCount > 0 &&
    around === 0
      ? "hooks"
      : undefined

  // The same hooks around a body schema: the fused closure runs parse, validate, derive, before,
  // handler and after in one function frame, the win `fusedBody` already gives the no-hooks shape.
  const fusedBodyLifecycle =
    lane === "lifecycle" &&
    !authBeforeValidation &&
    schema?.body !== undefined &&
    schema?.query === undefined &&
    plain &&
    schema?.onValidationError === undefined &&
    !defaultOnValidationError &&
    !hasResponseContract &&
    !hasIdempotency &&
    !hasLedger &&
    hookCount > 0 &&
    around === 0

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
              : (lifecycleHookLane ?? (fusedBodyLifecycle ? "body-hooks" : undefined))
        : undefined,
  }
}
