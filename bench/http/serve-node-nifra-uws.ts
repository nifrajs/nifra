/**
 * nifra on Node through `@nifrajs/node-uws` - the shared bench app (see _nifra-app.ts) served by
 * uWebSockets.js instead of `node:http`. Bundled for Node exactly like serve-node-nifra.ts; the
 * uWebSockets.js addon is not bundled, so run.ts points `NODE_PATH` at the copy the workspace
 * installed for `packages/node-uws`.
 *
 *   node <bundled serve-node-nifra-uws.js> <port>
 */
import { serve } from "@nifrajs/node-uws"
import { makeNifraApp } from "./_nifra-app.ts"

const port = Number(process.argv[2])
if (!Number.isInteger(port)) {
  throw new Error("usage: node <bundled serve-node-nifra-uws.js> <port>")
}

await serve(makeNifraApp(), { port })
