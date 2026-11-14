/**
 * nifra on Node through `@nifrajs/node-uws` - the shared realistic-shape bench app (see
 * _nifra-app.ts) served by uWebSockets.js instead of `node:http`. The optional `body` arg adds the
 * same body-hash middleware as serve-node-nifra.ts, so the two Node transports run the identical
 * app and differ only in the server under it. Workspace-only: the published tree installs no
 * `@nifrajs/node-uws`, so run.ts leaves this target out there.
 *
 *   node <bundled serve-node-nifra-uws.js> <port> [body]
 */
import { serve } from "@nifrajs/node-uws"
import { responseObserver } from "../../packages/core/dist/response-observer.js"
import { makeNifraApp } from "./_nifra-app.ts"

const port = Number(process.argv[2])
if (!Number.isInteger(port)) {
  throw new Error("usage: node <bundled serve-node-nifra-uws.js> <port> [body]")
}

function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

const app = makeNifraApp()
if (process.argv[3] === "body") {
  app.use(responseObserver()).onResponseBody(
    (body, headers) => {
      headers.set(
        "x-body-hash",
        hash(typeof body === "string" ? body : new TextDecoder().decode(body)),
      )
      return undefined
    },
    (body, res) => {
      res.headers ??= {}
      res.headers["x-body-hash"] =
        typeof body === "string" ? hash(body) : hash(new TextDecoder().decode(body))
      return undefined
    },
  )
}

await serve(app, { port })
