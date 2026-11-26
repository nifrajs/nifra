/**
 * nifra on Node through `@nifrajs/node-engine` - the shared bench app (see _nifra-app.ts) served by
 * the in-repo Rust engine instead of `node:http`. Bundled for Node like serve-node-nifra.ts; the
 * native addon is the one `NIFRA_RUST_ENGINE_PATH` names.
 *
 *   node <bundled serve-node-nifra-engine.js> <port>
 */
import { serve } from "../../packages/node-engine/src/index.ts"
import { makeNifraApp } from "./_nifra-app.ts"

const port = Number(process.argv[2])
if (!Number.isInteger(port)) {
  throw new Error("usage: node <bundled serve-node-nifra-engine.js> <port>")
}

await serve(makeNifraApp(), { port })
