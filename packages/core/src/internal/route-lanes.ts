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
  readonly lifecycleHookLane: "derive-before" | "derive-before-after" | undefined
  readonly fusedLane: "bare" | "body" | "query" | undefined
}

export function selectRouteLanes(options: {
  readonly schema: RouteSchema | undefined
  readonly hasIdempotency: boolean
  readonly hasLedger: boolean
  readonly hasResponseContract: boolean
  readonly hasDecorations: boolean
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
    hasDecorations,
    derives,
    beforeHandle,
    afterHandle,
    onError,
    around,
    defaultOnValidationError,
  } = options

  const bare =
    schema?.params === undefined &&
    schema?.headers === undefined &&
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
    !hasResponseContract &&
    schema?.query !== undefined &&
    schema.body === undefined &&
    schema.params === undefined &&
    schema.headers === undefined &&
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
    !hasResponseContract &&
    schema?.body !== undefined &&
    schema.query === undefined &&
    schema.params === undefined &&
    schema.headers === undefined &&
    derives === 0 &&
    beforeHandle === 0 &&
    afterHandle === 0 &&
    onError === 0

  const fusedBody =
    !bare &&
    bodyOnly &&
    schema.onValidationError === undefined &&
    !defaultOnValidationError &&
    !hasIdempotency &&
    !hasLedger &&
    around === 0

  const lane: RouteExecutionLane = bare
    ? "bare"
    : bodyOnly
      ? "body"
      : !hasResponseContract &&
          schema?.body === undefined &&
          schema?.query !== undefined &&
          schema.params === undefined &&
          schema.headers === undefined &&
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
    lane !== "lifecycle" || schema?.params !== undefined || schema?.headers !== undefined
      ? undefined
      : schema?.body !== undefined
        ? schema.query !== undefined
          ? "body-query"
          : "body"
        : schema?.query !== undefined
          ? "query"
          : "hooks"

  // The realistic middleware shape is commonly exactly one synchronous-or-async derive followed by
  // one before hook. Keep the generic runner for every route that can observe decorations, after hooks,
  // error hooks, or response contracts; this lane only removes the two per-request hook-loop dispatches
  // and preserves the same async continuations and error handling.
  const lifecycleHookLane =
    lane === "lifecycle" &&
    !hasResponseContract &&
    !hasDecorations &&
    derives === 1 &&
    beforeHandle === 1 &&
    afterHandle <= 1 &&
    onError === 0
      ? afterHandle === 0
        ? "derive-before"
        : "derive-before-after"
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
              : undefined
        : undefined,
  }
}
