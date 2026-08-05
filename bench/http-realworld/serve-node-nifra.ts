/**
 * nifra on Node - the shared realistic-shape bench app (see _nifra-app.ts) served through
 * `@nifrajs/node`. Run as a Node-targeted bundle (see bench/http/serve-node-nifra.ts for why);
 * run.ts builds this via `Bun.build({ target: "node" })` before spawning it.
 *
 *   node <bundled serve-node-nifra.js> <port>
 */
import { serve } from "@nifrajs/node"
import { makeNifraApp } from "./_nifra-app.ts"

const port = Number(process.argv[2])
if (!Number.isInteger(port)) {
  throw new Error("usage: node <bundled serve-node-nifra.js> <port>")
}

await serve(makeNifraApp(), { port })
