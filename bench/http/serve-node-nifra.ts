/**
 * nifra on Node — the shared bench app (see _nifra-app.ts) served through `@nifrajs/node`,
 * which bridges Node's `http` (req,res) ↔ nifra's Web-standard `app.fetch`.
 *
 * Run as a Node-targeted BUNDLE: real Node can't resolve the `@nifrajs/*` workspace
 * packages (Bun resolves them via tsconfig paths, which Node ignores; the published
 * dist imports `@nifrajs/core` by name), so run.ts builds this via `Bun.build({ target:
 * "node" })` first — which is also nifra's actual Node deploy path (a single-file
 * bundle). The Web Request/Response adaptation in `@nifrajs/node` is real per-request
 * overhead, so this row is honestly expected to trail the Node-native frameworks.
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
