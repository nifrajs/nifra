// node workload-serve.mjs <raw|declarative|nifra> <port>
// The web-frameworks-benchmark workload: GET / (empty 200), GET /user/:id (id as body), POST /user (empty 200).
import { createRequire } from "node:module"

const [arm, portArg] = process.argv.slice(2)
const port = Number(portArg)
const require = createRequire(new URL("../../packages/node-uws/package.json", import.meta.url))

if (arm === "nifra") {
  const { echoParam, server, staticResponse } = await import("@nifrajs/core/server")
  const { serve } = await import("@nifrajs/node-uws")
  const app = server()
    .get("/", staticResponse())
    .get("/user/:id", echoParam("/user/:id"))
    .post("/user", staticResponse())
  await serve(app, { port })
  console.log("ready")
} else {
  const { App, DeclarativeResponse, _cfg } = require("uWebSockets.js")
  _cfg("silent")
  const app = App()
  if (arm === "declarative" || arm === "declarative-ct") {
    app.get("/", new DeclarativeResponse().end())
    const user = new DeclarativeResponse()
    if (arm === "declarative-ct") user.writeHeader("content-type", "text/plain; charset=utf-8")
    app.get("/user/:id", user.writeParameterValue("id").end())
    app.post("/user", new DeclarativeResponse().end())
  } else if (arm === "fastjs") {
    // The candidate: a JS callback answering the param route itself, the app's generic path for anything odd.
    app.get("/", new DeclarativeResponse().end())
    app.get("/user/:id", (res, req) => {
      const id = req.getParameter(0)
      if (id === undefined || id.length === 0 || id.indexOf("%") !== -1) {
        res.writeStatus("404 Not Found").end()
        return
      }
      res.cork(() => {
        res.writeStatus("200 OK")
        res.writeHeader("content-type", "text/plain; charset=utf-8")
        res.end(id)
      })
    })
    app.post("/user", new DeclarativeResponse().end())
  } else {
    app.get("/", (res) => res.end())
    app.get("/user/:id", (res, req) => res.end(req.getParameter(0)))
    app.post("/user", (res) => {
      res.onAborted(() => {})
      res.onData((_c, last) => last && res.end())
    })
  }
  app.listen("127.0.0.1", port, (t) => {
    if (!t) process.exit(1)
    console.log("ready")
  })
}
