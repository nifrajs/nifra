/**
 * Node server for the static-response-header A/B, through `@nifrajs/node` (see
 * _static-headers-app.ts). Bundled for Node by the runner, exactly like serve-node-nifra.ts.
 *
 *   node <bundled serve-node-static-headers.js> <static|hook> <port>
 */
import { serve } from "@nifrajs/node"
import { makeStaticHeadersApp, variantOf } from "./_static-headers-app.ts"

const variant = variantOf(process.argv[2])
const port = Number(process.argv[3])
if (!Number.isInteger(port)) {
  throw new Error("usage: node <bundled serve-node-static-headers.js> <static|hook> <port>")
}

await serve(makeStaticHeadersApp(variant), { port })
