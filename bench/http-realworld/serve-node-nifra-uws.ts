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
import { makeNifraNodeApp } from "./_nifra-node-app.ts"

const port = Number(process.argv[2])
if (!Number.isInteger(port)) {
  throw new Error("usage: node <bundled serve-node-nifra-uws.js> <port> [body]")
}

await serve(makeNifraNodeApp(process.argv[3] === "body"), { port })
