/**
 * node bench/node-uws/dist/serve.js <node|uws|raw> <bare|real> <port>
 * `bare` = bench/http/_nifra-app.ts, `real` = bench/http-realworld/_nifra-app.ts.
 * `raw` is uWebSockets.js with no framework at all: the ceiling a transport can reach.
 */
import { createRequire } from "node:module"
import { serve } from "@nifrajs/node"
import { serve as serveUws } from "@nifrajs/node-uws"
import { makeNifraApp as makeBare } from "../http/_nifra-app.ts"
import { makeNifraApp as makeReal, ORDERS } from "../http-realworld/_nifra-app.ts"

const [transport, shape, portArg] = process.argv.slice(2)
const port = Number(portArg)
if (
  (transport !== "node" && transport !== "uws" && transport !== "raw") ||
  (shape !== "bare" && shape !== "real") ||
  !Number.isInteger(port)
) {
  throw new Error("usage: serve.js <node|uws|raw> <bare|real> <port>")
}

if (transport === "raw") {
  interface RawResponse {
    cork(fn: () => void): void
    writeStatus(status: string): void
    writeHeader(name: string, value: string): void
    end(body: string): void
    onAborted(fn: () => void): void
    onData(fn: (chunk: ArrayBuffer, isLast: boolean) => void): void
  }
  interface RawApp {
    get(path: string, fn: (res: RawResponse) => void): RawApp
    post(path: string, fn: (res: RawResponse) => void): RawApp
    listen(host: string, port: number, fn: (token: unknown) => void): RawApp
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: require is untyped; this is the module's own shape
  const uWS = createRequire(import.meta.url)("uWebSockets.js") as { App(): RawApp }
  // Serialized per request on `real`, as the framework does; `bare` is the fixed hello-world body.
  const payload = { user: "abcdefghijkl", theme: "dark", orders: ORDERS.slice(0, 10), total: 25 }
  const bodyOf = (): string => (shape === "bare" ? '{"hello":"world"}' : JSON.stringify(payload))
  const headers: Array<[string, string]> =
    shape === "bare"
      ? []
      : [
          ["x-content-type-options", "nosniff"],
          ["x-frame-options", "DENY"],
          ["referrer-policy", "no-referrer"],
          ["vary", "Origin"],
          ["access-control-allow-origin", "https://app.example.com"],
          ["access-control-allow-credentials", "true"],
        ]
  const answer = (res: RawResponse): void => {
    res.cork(() => {
      res.writeStatus("200 OK")
      for (const [name, value] of headers) res.writeHeader(name, value)
      if (shape === "real") res.writeHeader("x-request-id", crypto.randomUUID())
      res.writeHeader("content-type", "application/json")
      res.end(bodyOf())
    })
  }
  uWS
    .App()
    .get("/*", (res) => {
      res.onAborted(() => {})
      answer(res)
    })
    .post("/*", (res) => {
      res.onAborted(() => {})
      res.onData((_chunk, isLast) => {
        if (isLast) answer(res)
      })
    })
    .listen("127.0.0.1", port, (token) => {
      if (!token) throw new Error("raw: cannot listen")
    })
} else {
  const app = shape === "bare" ? makeBare() : makeReal()
  if (transport === "node") await serve(app, { port })
  else await serveUws(app, { port })
}
console.log(`${transport}/${shape} up on ${port}`)
