/**
 * One server for bridge-http.ts: `GET /users/:id` behind `tracing()` (a no-op exporter), with or without
 * the OTel SDK bridge's `around()` plugin. Runs on Bun (`Bun.serve` via `app.listen`) and on Node
 * (`@nifrajs/node`; needs `bun run build && bun run scripts/link-for-node.ts`).
 *
 *   <bun|node> bench/otel/serve-bridge.ts <port> <tracing|bridge>
 */
import { createRequire } from "node:module"
import { server } from "@nifrajs/core"
import { tracing } from "@nifrajs/otel"
import { type OtelApi, otelBridge } from "@nifrajs/otel/sdk-bridge"

const port = Number(process.argv[2])
const variant = process.argv[3]
if (!Number.isInteger(port) || (variant !== "tracing" && variant !== "bridge")) {
  throw new Error("usage: serve-bridge.ts <port> <tracing|bridge>")
}

let app = server().use(tracing({ exporter: { onEnd() {} } }))
if (variant === "bridge") {
  // The OTel packages are @nifrajs/otel's test devDependencies, so resolve them from there.
  const require = createRequire(new URL("../../packages/otel/package.json", import.meta.url))
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: require() is untyped; this resolves @opentelemetry/api from packages/otel, and packages/otel/test/sdk-bridge.test.ts type-checks that module as an OtelApi.
  const api = require("@opentelemetry/api") as OtelApi & {
    context: { setGlobalContextManager(manager: unknown): boolean }
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: require() is untyped; this resolves @opentelemetry/context-async-hooks ^2.11 from packages/otel, which exports this class with enable().
  const { AsyncLocalStorageContextManager } = require("@opentelemetry/context-async-hooks") as {
    AsyncLocalStorageContextManager: new () => { enable(): unknown }
  }
  api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  app = app.use(otelBridge({ api }).plugin)
}
const routed = app.get("/users/:id", (c) => ({ id: c.params.id }))

if ("Bun" in globalThis) {
  routed.listen(port, { hostname: "127.0.0.1" })
} else {
  const { serve } = await import("@nifrajs/node")
  await serve(routed, { port, hostname: "127.0.0.1" })
}
