/**
 * nifra on Node - the shared realistic-shape bench app (see _nifra-app.ts) served through
 * `@nifrajs/node`. Run as a Node-targeted bundle (see bench/http/serve-node-nifra.ts for why);
 * run.ts builds this via `Bun.build({ target: "node" })` before spawning it.
 *
 * With the optional `body` arg, adds ONE body-observing middleware (an `x-body-hash` header over
 * the final serialized body) via nifra's `onResponseBody` payload tier - the body-hash workload's
 * nifra row (the peers' rows live in serve-node.ts as `*-body`).
 *
 *   node <bundled serve-node-nifra.js> <port> [body]
 */
import { serve } from "@nifrajs/node"
import { makeNifraApp } from "./_nifra-app.ts"

const port = Number(process.argv[2])
if (!Number.isInteger(port)) {
  throw new Error("usage: node <bundled serve-node-nifra.js> <port> [body]")
}

// djb2 over the serialized body - deliberately cheap; the workload prices the middleware TIER (how
// the bytes reach the hook), not the hash itself.
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

const app = makeNifraApp()
if (process.argv[3] === "body") {
  app.onResponseBody((body, headers) => {
    headers.set(
      "x-body-hash",
      hash(typeof body === "string" ? body : new TextDecoder().decode(body)),
    )
    return undefined
  })
}

await serve(app, { port })
