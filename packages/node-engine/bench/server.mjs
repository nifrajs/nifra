// usage: node server.mjs <nifra-engine|nifra-engine-host|nifra-node|nifra-uws|moro|raw-nifra-engine|raw-uws|raw-node|raw-moro-engine> <port>
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
} else if (target === "raw-moro-engine") {
  // `@morojs/engine` straight on its API: its ceiling with no framework above it.
  if (MORO_DIR === undefined) throw new Error("MORO_DIR is required for raw-moro-engine")
  const { handle, decode } = await load(new URL("./raw-handler.mjs", import.meta.url).pathname)
  const engine = createRequire(`${MORO_DIR}/`)("@morojs/engine")
  const METHODS = ["GET", "POST"]
  const serverId = engine.serve(
    {
      onRequest(id, methodIdx, path) {
        const method = METHODS[methodIdx] ?? ""
        const body = method === "POST" ? decode(engine.getBody(id)) : null
        const [status, type, text] = handle(method, path, body)
        engine.respond(id, status, ["content-type", type], text)
      },
      onAborted() {},
    },
    { maxBodySize: 1_048_576 },
  )
  engine.listen(serverId, "0.0.0.0", port)
} else if (target === "raw-nifra-engine" || target === "raw-nifra-engine-ct") {
  // The Rust addon straight on its batch ABI, the way `serve()` drives it, with no adapter and no core.
  const { handle } = await load(new URL("./raw-handler.mjs", import.meta.url).pathname)
  const addonPath = process.env.NIFRA_RUST_ENGINE_PATH
  if (addonPath === undefined)
    throw new Error("NIFRA_RUST_ENGINE_PATH is required for raw-nifra-engine")
  const module = { exports: {} }
  process.dlopen(module, addonPath)
  const addon = module.exports
  const readContentType = target === "raw-nifra-engine-ct"
  const METHODS = ["GET", "POST"]
  const HAS_BODY = 1 << 4
  const LARGE_BODY = 1 << 10
  const templates = new Map()
  let server
  let bufs
  const template = (status, type) => {
    const key = `${status} ${type}`
    let id = templates.get(key)
    if (id === undefined) {
      id = server.prepareResponse(status, ["content-type", type])
      templates.set(key, id)
    }
    return id
  }
  const onBatch = (count) => {
    const { inMeta, inData, outMeta, outData, inSlotU32s, outSlotU32s } = bufs
    let outCount = 0
    let outOff = 0
    for (let i = 0; i < count; i++) {
      const b = i * inSlotU32s
      const reqId = inMeta[b]
      const flags = inMeta[b + 1]
      const method = METHODS[flags & 0x0f] ?? ""
      const path = inData.toString("latin1", inMeta[b + 2], inMeta[b + 2] + inMeta[b + 3])
      let body = null
      if ((flags & HAS_BODY) !== 0) {
        body =
          (flags & LARGE_BODY) === 0
            ? inData.toString("utf8", inMeta[b + 6], inMeta[b + 6] + inMeta[b + 7])
            : (server.getBody(reqId)?.toString("utf8") ?? "")
      }
      // `-ct` reads the one header an adapter must read on a POST, to price a header call on its own.
      if (readContentType && body !== null) server.getHeader(reqId, "content-type")
      const [status, type, text] = handle(method, path, body)
      const len = outData.write(text, outOff, "utf8")
      const ob = outCount * outSlotU32s
      outMeta[ob] = reqId
      outMeta[ob + 1] = template(status, type)
      outMeta[ob + 2] = outOff
      outMeta[ob + 3] = len
      outOff += len
      outCount += 1
    }
    server.flushResponses(outCount)
  }
  server = addon.createUvServer("0.0.0.0", port, onBatch, { maxBodySize: 2_097_152 })
  bufs = server.getBatchBuffers()
} else if (target === "raw-uws") {
  const { handle, decode } = await load(new URL("./raw-handler.mjs", import.meta.url).pathname)
  const uws = createRequire(`${ROOT}/packages/node-uws/`)("uWebSockets.js")
  const cfg = Reflect.get(uws, "_cfg")
  if (typeof cfg === "function") Reflect.apply(cfg, uws, ["silent"])
  const reply = (res, [status, type, text]) =>
    res.cork(() => {
      res.writeStatus(
        `${status} ${status === 200 ? "OK" : status === 400 ? "Bad Request" : "Not Found"}`,
      )
      res.writeHeader("content-type", type)
      res.end(text)
    })
  uws
    .App()
    .any("/*", (res, req) => {
      const method = req.getMethod().toUpperCase()
      const path = req.getUrl()
      if (method !== "POST") return reply(res, handle(method, path, null))
      const chunks = []
      res.onAborted(() => {})
      res.onData((chunk, last) => {
        chunks.push(Buffer.from(chunk.slice(0)))
        if (last) reply(res, handle(method, path, decode(Buffer.concat(chunks))))
      })
    })
    .listen("0.0.0.0", port, () => {})
} else if (target === "raw-node") {
  const { handle } = await load(new URL("./raw-handler.mjs", import.meta.url).pathname)
  const http = await import("node:http")
  http
    .createServer((req, res) => {
      const finish = (body) => {
        const [status, type, text] = handle(req.method, req.url, body)
        res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(text) })
        res.end(text)
      }
      if (req.method !== "POST") return finish(null)
      const chunks = []
      req.on("data", (chunk) => chunks.push(chunk))
      req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")))
    })
    .listen(port, "0.0.0.0")
} else throw new Error(`unknown target ${target}`)
console.error("ready", target, port)
