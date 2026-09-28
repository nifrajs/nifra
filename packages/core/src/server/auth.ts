import type { ResponseResult } from "./runtime-core.ts"

/** A promise-or-value return used by authentication providers. */
export type AuthMaybePromise<T> = T | Promise<T>

/**
 * The deliberately narrow header surface given to an authentication provider.
 *
 * It is not a `Headers` object: providers can inspect credentials, but cannot mutate the request
 * headers or reach the request body through this value. The server constructs the view per request.
 */
export interface AuthHeaders {
  readonly get: (name: string) => string | null
  readonly has: (name: string) => boolean
  readonly forEach: (callback: (value: string, name: string) => void) => void
}

/**
 * The authentication trust boundary. There is intentionally no `Request`, `body`, or parsed query
 * here. Route parameters are present only for selecting an identity policy and remain untrusted
 * strings until the normal route validation stage completes.
 */
export interface AuthenticationInput<Env = unknown> {
  readonly method: string
  readonly pathname: string
  readonly headers: AuthHeaders
  readonly params: Readonly<Record<string, string>>
  readonly env: Env
  readonly clientIp: string | undefined
  readonly signal: AbortSignal
}

export type AuthenticationFailureReason = "unauthenticated" | "forbidden" | "unavailable"

export interface AuthenticationSuccess<Principal> {
  readonly kind: "authenticated"
  readonly principal: Principal
}

export interface AuthenticationFailure {
  readonly kind: "rejected"
  readonly reason?: AuthenticationFailureReason
  /** An integration may provide a redirect or protocol-specific challenge response. */
  readonly response?: Response | ResponseResult
}

export type AuthenticationResult<Principal> =
  | AuthenticationSuccess<Principal>
  | AuthenticationFailure

/**
 * A dedicated authentication stage. Stages are captured by route scope at registration time and
 * execute before input validation on required protected routes.
 */
export interface AuthenticationStage<Principal = unknown, Env = unknown> {
  readonly id: string
  /** Declares the common path so the compiler can preserve a synchronous protected lane. */
  readonly mode?: "sync" | "async"
  readonly run: (
    input: AuthenticationInput<Env>,
  ) => AuthMaybePromise<AuthenticationResult<Principal>>
}

export function authenticated<Principal>(principal: Principal): AuthenticationSuccess<Principal> {
  return { kind: "authenticated", principal }
}

export function rejected(
  reason: AuthenticationFailureReason = "unauthenticated",
  response?: Response | ResponseResult,
): AuthenticationFailure {
  return response === undefined
    ? { kind: "rejected", reason }
    : { kind: "rejected", reason, response }
}
