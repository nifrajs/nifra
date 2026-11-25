// usage: node server.mjs <nifra-engine|nifra-engine-host|nifra-node|nifra-uws|moro|moro-engine> <port>
// ROOT is the nifra checkout (built). MORO_DIR is packages/node-engine/bench/moro after `npm ci` there:
// the competitors are installed only for this benchmark and are not a dependency of any nifra package.
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

const ROOT = process.env.ROOT ?? process.cwd()
const MORO_DIR = process.env.MORO_DIR
const [target, portArg] = process.argv.slice(2)
const port = Number(portArg)
const load = (path) => import(pathToFileURL(path).href)

if (target.startsWith("nifra-")) {
  const { server, staticResponse } = await load(`${ROOT}/packages/core/dist/index.js`)
  const { t } = await load(`${ROOT}/packages/schema/dist/index.js`)
  const app = server()
    .get("/user/:id", (c) => ({ id: c.params.id }))
    .get("/ping", staticResponse())
    .post("/users", { body: t.object({ name: t.string() }) }, (c) => ({
      ok: true,
      name: c.body.name,
    }))
  const adapter = {
    "nifra-engine": "node-engine",
    "nifra-engine-host": "node-engine",
    "nifra-node": "node",
    "nifra-uws": "node-uws",
  }[target]
  if (adapter === undefined) throw new Error(`unknown target ${target}`)
  const { serve } = await load(`${ROOT}/packages/${adapter}/dist/index.js`)
  await serve(app, target === "nifra-engine-host" ? { port, validateHost: true } : { port })
} else if (target === "moro") {
  if (MORO_DIR === undefined) throw new Error("MORO_DIR is required for moro")
  const { createApp } = await load(`${MORO_DIR}/node_modules/@morojs/moro/dist/index.js`)
  const { z } = await load(`${MORO_DIR}/node_modules/zod/index.js`)
  const app = await createApp({ server: { engine: "moro" }, logging: { level: "error" } })
  app.get("/user/:id").handler((req) => ({ id: req.params.id }))
  app.get("/ping").handler("ok")
  app
    .post("/users")
    .body(z.object({ name: z.string() }))
    .handler((req) => ({ ok: true, name: req.body.name }))
  app.listen(port, () => console.error("engine:", JSON.stringify(app.engine)))
} else if (target === "moro-engine") {
  // The same three routes written straight on `@morojs/engine`: its ceiling with no framework above it.
  if (MORO_DIR === undefined) throw new Error("MORO_DIR is required for moro-engine")
  const engine = createRequire(`${MORO_DIR}/`)("@morojs/engine")
  const JSON_HEADERS = ["content-type", "application/json"]
  const decoder = new TextDecoder()
  const serverId = engine.serve(
    {
      onRequest(id, methodIdx, path) {
        if (methodIdx === 0) {
          if (path.startsWith("/user/") && path.length > 6) {
            const segment = path.slice(6)
            if (!segment.includes("/")) {
              engine.respond(id, 200, JSON_HEADERS, `{"id":${JSON.stringify(segment)}}`)
              return
            }
          }
          if (path === "/ping") engine.respond(id, 200, ["content-type", "text/plain"], "ok")
          else engine.respond(id, 404, JSON_HEADERS, '{"error":"not_found"}')
          return
        }
        if (methodIdx === 1 && path === "/users") {
          const body = engine.getBody(id)
          try {
            const parsed = JSON.parse(body === null ? "" : decoder.decode(body))
            if (typeof parsed?.name !== "string") throw new TypeError("name")
            engine.respond(id, 200, JSON_HEADERS, JSON.stringify({ ok: true, name: parsed.name }))
          } catch {
            engine.respond(id, 400, JSON_HEADERS, '{"error":"bad_request"}')
          }
          return
        }
        engine.respond(id, 404, JSON_HEADERS, '{"error":"not_found"}')
      },
      onAborted() {},
    },
    { maxBodySize: 1_048_576 },
  )
  engine.listen(serverId, "0.0.0.0", port)
} else throw new Error(`unknown target ${target}`)
console.error("ready", target, port)
