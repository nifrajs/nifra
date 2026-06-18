import { FRAMEWORK_NAME } from "./internal/brand.ts"

/**
 * Base class for every error the framework throws. Carries a stable, string
 * `code` so callers can branch on the failure programmatically rather than
 * matching on message text. Messages are prefixed with the brand name.
 */
export class FrameworkError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(`[${FRAMEWORK_NAME}] ${message}`)
    this.name = "FrameworkError"
    this.code = code
  }
}

/** Stable codes for boot-time (L2) route configuration failures. */
export type RouteConfigErrorCode =
  | "DUPLICATE_ROUTE"
  | "DUPLICATE_PARAM"
  | "PARAM_NAME_CONFLICT"
  | "INVALID_PATH"
  | "INVALID_PARAM_NAME"
  | "WILDCARD_NOT_LAST"
  | "INVALID_METHOD"

/**
 * Thrown at route registration when a route is misconfigured. This is the
 * boot-time rejection layer: loud and early,
 * never deferred to the first request.
 */
export class RouteConfigError extends FrameworkError {
  // Narrows the inherited `code` to the closed union without re-initializing it.
  declare readonly code: RouteConfigErrorCode

  constructor(code: RouteConfigErrorCode, message: string) {
    super(code, message)
    this.name = "RouteConfigError"
  }
}
