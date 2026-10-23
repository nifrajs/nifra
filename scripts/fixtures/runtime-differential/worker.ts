/**
 * The differential app as a Workers module. There is no filesystem, so no static files. A socket
 * lives in one isolate, so WebSocket upgrades go to a Durable Object hub, the documented way to give
 * `app.publish` every connection.
 */
import type { DurableObjectNamespaceLike } from "@nifrajs/core"
import { toFetchHandler } from "@nifrajs/core/edge"
import { createWebSocketHub } from "@nifrajs/workers"
import { createDifferentialApp } from "./app.ts"

interface Env {
  readonly NIFRA_WS_HUB: DurableObjectNamespaceLike
}

const app = createDifferentialApp()

export const NifraWebSocketHub = createWebSocketHub(app)
export default toFetchHandler(app, { webSocketHub: (env: Env) => env.NIFRA_WS_HUB })
