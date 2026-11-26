/**
 * nifra on Node - the shared realistic-shape bench app (see _nifra-app.ts) served through
 * `@nifrajs/node`. Run as a Node-targeted bundle (see bench/http/serve-node-nifra.ts for why);
 * run.ts builds this via `Bun.build({ target: "node" })` before spawning it.
 *
 * With the optional `body` arg, adds ONE body-observing middleware (an `x-body-hash` header over
 * the final serialized body) via nifra's `onResponseBody` payload tier - the body-hash workload's
 * nifra row (the peers' rows live in serve-node.ts as `*-body`). The portable hook carries the
 * row on every runtime; the paired Node-direct twin (same bytes in, same header out, no
 * header-view allocation) carries it on the measured Node lane - the same twin pattern the CORS
 * middleware uses, and what idiomatic perf-sensitive body middleware looks like.
 *
 *   node <bundled serve-node-nifra.js> <port> [body]
 */
import { serve } from "@nifrajs/node"
import { makeNifraNodeApp } from "./_nifra-node-app.ts"

const port = Number(process.argv[2])
if (!Number.isInteger(port)) {
  throw new Error("usage: node <bundled serve-node-nifra.js> <port> [body]")
}

await serve(makeNifraNodeApp(process.argv[3] === "body"), { port })
