/** Lazy Node-direct renderer seam. The base server retains the typed method but not its renderer. */

import type { Platform } from "./context.ts"
import type { NodeServeOutcome } from "./node-outcome.ts"
import type { CtxSet, MaybePromise } from "./server.ts"

/** Allocation-light request view used by Node-native header middleware. */
export interface NodeRequestContext {
  readonly method: string
  readonly header: (name: string) => string | null
}

/** Native equivalent of a paired `onRequest` hook. It may short-circuit, but cannot rewrite a request. */
export type NodeRequestHook = (
  request: NodeRequestContext,
  platform?: Platform,
) => MaybePromise<Response | undefined>

/**
 * Header-only response view used by Node-direct middleware. It intentionally has no body or status
 * mutator: a native hook may add/replace transport headers, but body/status transformations must stay
 * on the Web Response path where their semantics are fully observable.
 */
export interface NodeResponseContext {
  readonly status: number
  headers: Record<string, string | readonly string[]> | undefined
  readonly cookies: readonly string[] | undefined
}

/** Native equivalent of a paired `onResponse` hook. It must preserve the Web hook's header semantics. */
export type NodeResponseHook = (
  response: NodeResponseContext,
  req: NodeRequestContext,
) => MaybePromise<void>

export interface NodeOutcomeRuntime {
  toOutcome(result: unknown, set: CtxSet): NodeServeOutcome
  /** Materialize a buffered outcome for a Web response hook without losing its direct-write marker. */
  toResponse(outcome: NodeServeOutcome): Response
  fromResponse(response: Response): NodeServeOutcome
  timeout(): NodeServeOutcome
}
