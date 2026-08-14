/**
 * nifra's reverse proxy on Node - `@nifrajs/proxy` mounted on a nifra server, served through
 * `@nifrajs/node`'s `serve()` (Node `http` ↔ Web-standard `app.fetch`).
 *
 * Run as a Node-targeted BUNDLE: real Node cannot resolve the `@nifrajs/*` workspace packages
 * (Bun resolves them via tsconfig paths, which Node ignores), so run.ts builds this with
 * `Bun.build({ target: "node" })` first - which is also nifra's actual Node deploy path. The
 * per-request Web Request/Response adaptation is real overhead this row honestly pays.
 *
 * The transport arg selects the upstream hop, which is the whole reason this row exists twice:
 *   fetch  - the default portable transport, `fetch()` over undici's spec-compliant wrapper
 *   undici - `@nifrajs/proxy/undici`, straight to undici's dispatcher, skipping that wrapper
 *
 * `undici` stays external to the bundle so Node loads the real package (bench's own devDep) rather
 * than an inlined copy of a client that carries wasm.
 *
 *   node <bundled serve-node-nifra.js> <port> <upstreamPort> [fetch|undici]
 */

import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"
import { createProxy, type ProxyOptions } from "@nifrajs/proxy"
import { undiciTransport } from "@nifrajs/proxy/undici"

const port = Number(process.argv[2])
const upstreamPort = Number(process.argv[3])
const mode = process.argv[4] ?? "fetch"
if (!Number.isInteger(port) || !Number.isInteger(upstreamPort)) {
  throw new Error("usage: node <bundled serve-node-nifra.js> <port> <upstreamPort> [fetch|undici]")
}
if (mode !== "fetch" && mode !== "undici") {
  throw new Error(`unknown transport "${mode}" (fetch | undici)`)
}

const options: ProxyOptions = {
  upstream: `http://127.0.0.1:${upstreamPort}`,
  ...(mode === "undici" ? { transport: undiciTransport() } : {}),
}
const app = server().mountFetch("/", createProxy(options))

await serve(app, { port })
