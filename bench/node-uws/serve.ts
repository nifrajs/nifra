/**
 * node bench/node-uws/dist/serve.js <node|uws> <bare|real> <port>
 * `bare` = bench/http/_nifra-app.ts, `real` = bench/http-realworld/_nifra-app.ts
 */
import { serve } from "@nifrajs/node"
import { serve as serveUws } from "@nifrajs/node-uws"
import { makeNifraApp as makeBare } from "../http/_nifra-app.ts"
import { makeNifraApp as makeReal } from "../http-realworld/_nifra-app.ts"

const [transport, shape, portArg] = process.argv.slice(2)
const port = Number(portArg)
if (
  (transport !== "node" && transport !== "uws") ||
  (shape !== "bare" && shape !== "real") ||
  !Number.isInteger(port)
) {
  throw new Error("usage: serve.js <node|uws> <bare|real> <port>")
}
const app = shape === "bare" ? makeBare() : makeReal()
if (transport === "node") await serve(app, { port })
else await serveUws(app, { port })
console.log(`${transport}/${shape} up on ${port}`)
