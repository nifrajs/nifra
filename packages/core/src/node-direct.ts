/**
 * The opt-in Node-direct renderer plugin.
 *
 * `.use(nodeDirect())` enables `app.resolveNode()` for callers that invoke it themselves. Normal
 * `@nifrajs/node` serving supplies the renderer directly, so it never needs this; only direct
 * `resolveNode()` callers do. Same `.use()` install seam as `mcp()` / `idempotency()`.
 */
import { INSTALL_NODE_DIRECT } from "./server/install.ts"
import { nodeOutcomeFromResponse, toNodeOutcome } from "./server/node-outcome.ts"
import type { NodeOutcomeRuntime } from "./server/node-outcome-hook.ts"
import type { IdentityPlugin } from "./server/plugin.ts"
import type { AnyServer } from "./server/server.ts"

const NODE_OUTCOME_RUNTIME: NodeOutcomeRuntime = {
  toOutcome: toNodeOutcome,
  fromResponse: nodeOutcomeFromResponse,
  timeout: () => ({
    kind: "response",
    response: Response.json({ ok: false, error: "request_timeout" }, { status: 503 }),
  }),
}

/** The install seam a server exposes so the `nodeDirect()` plugin can hand it the renderer. */
interface NodeDirectInstallable {
  [INSTALL_NODE_DIRECT](runtime: NodeOutcomeRuntime): void
}

/** Enable `app.resolveNode()` for direct callers. Applying it twice is a no-op (named plugin dedupe). */
export function nodeDirect(): IdentityPlugin {
  const apply = <S extends AnyServer>(app: S): S => {
    ;(app as unknown as NodeDirectInstallable)[INSTALL_NODE_DIRECT](NODE_OUTCOME_RUNTIME)
    return app
  }
  return Object.assign(apply, { pluginName: "nifra:node-direct" }) as IdentityPlugin
}

export type { NodeServeOutcome } from "./server/node-outcome.ts"
