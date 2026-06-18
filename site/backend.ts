import { server } from "@nifrajs/core"

// Demo counter state. On Cloudflare this lives per-isolate (not durable) — a real app would use
// KV/D1/Durable Objects via `c.env`. Fine for a "this page is a live Nifra app" demo.
let count = 0

/**
 * The site's backend contract. Page loaders + the action call it in-process during SSR (no
 * network) — dogfooding Nifra's typed loader/action + Eden-style client.
 */
export const backend = server()
  .get("/stats", () => ({
    // From the current HTTP matrix. Same-run ratios are the useful signal; absolute throughput
    // varies by machine, runtime version, thermals, and benchmark window.
    pctOfRaw: 100, // Nifra GET / is effectively at raw Bun.serve in the current matrix.
    reqsPerSec: 118_000, // GET / on Bun, rounded from the latest local oha run.
    adapters: 5, // React, Solid, Vue, Preact, Svelte.
    runtimes: 4, // Bun, Node, Deno, Cloudflare/edge.
  }))
  .get("/count", () => ({ count }))
  .post("/count", () => {
    count += 1
    return { count }
  })
