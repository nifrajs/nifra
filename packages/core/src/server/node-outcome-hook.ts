/** Lazy Node-direct renderer seam. The base server retains the typed method but not its renderer. */
import type { NodeServeOutcome } from "./node-outcome.ts"
import type { CtxSet } from "./server.ts"

export interface NodeOutcomeRuntime {
  toOutcome(result: unknown, set: CtxSet): NodeServeOutcome
  fromResponse(response: Response): NodeServeOutcome
  timeout(): NodeServeOutcome
}
