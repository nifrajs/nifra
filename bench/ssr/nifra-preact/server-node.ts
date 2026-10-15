/**
 * The same handler as server.ts, on Node through @nifrajs/node's `serve` (node:http). Bundled by
 * build-node.ts, which puts client.js next to the bundle.
 *
 *   bun run bench/ssr/nifra-preact/build-node.ts && node bench/ssr/nifra-preact/dist-node/server-node.js
 */
import { readFileSync } from "node:fs"
import { serve } from "@nifrajs/node"
import { catalogHandler } from "./handler.ts"

const clientJs = readFileSync(new URL("./client.js", import.meta.url), "utf8")

await serve(
  { fetch: catalogHandler(clientJs) },
  { port: Number(process.env.PORT ?? 4323), hostname: "127.0.0.1" },
)
