/**
 * nifra on Node through `@nifrajs/node-engine`: the app of the other nifra Node rows, served by the
 * in-repo Rust engine. The native addon is the one `NIFRA_RUST_ENGINE_PATH` names.
 *
 *   node <bundled serve-node-nifra-engine.js> <port> [body]
 */
import { serve } from "../../packages/node-engine/src/index.ts"
import { makeNifraNodeApp } from "./_nifra-node-app.ts"

const port = Number(process.argv[2])
if (!Number.isInteger(port)) {
  throw new Error("usage: node <bundled serve-node-nifra-engine.js> <port> [body]")
}

await serve(makeNifraNodeApp(process.argv[3] === "body"), { port })
