/**
 * nifra worst-case app on Node via `@nifrajs/node`. Run as a Node-targeted BUNDLE
 * (built by run.ts via `Bun.build({ target: "node" })` - nifra's actual Node deploy
 * path; real Node can't resolve the workspace specifiers).
 *
 *   node <bundled serve-node-nifra-worst.js> <port>
 */
import { serve } from "@nifrajs/node"
import { makeWorstNifraApp } from "./_app.ts"

const port = Number(process.argv[2])
if (!Number.isInteger(port)) {
  throw new Error("usage: node <bundled serve-node-nifra-worst.js> <port>")
}

await serve(makeWorstNifraApp(), { port })
