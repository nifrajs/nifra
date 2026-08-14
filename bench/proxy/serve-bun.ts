/**
 * Per-framework reverse-proxy server for the BUN section, selected by CLI arg, forwarding the
 * IDENTICAL routes to the same upstream origin so the comparison is apples-to-apples. Spawned as
 * an isolated subprocess by run.ts.
 *
 * Every row mounts its framework's own idiomatic proxy helper inside that framework's own server -
 * the shape a user actually deploys - not the helper called in isolation:
 *   nifra      - `@nifrajs/proxy`'s `createProxy` behind `app.mountFetch("/")`
 *   nifra-bare - the SAME `createProxy` handler as `Bun.serve`'s fetch, with no nifra server in
 *                front. The `nifra` row necessarily includes the server's request pipeline while
 *                hono's row is a bare catch-all handler, so this row is the apples-to-apples
 *                `@nifrajs/proxy` vs `hono/proxy` comparison and the gap between the two nifra
 *                rows is what mounting inside a nifra server costs.
 *   hono       - `hono/proxy`'s `proxy()` from a catch-all handler
 *   bun-raw    - a hand-written `fetch` forward, NO hygiene (the ceiling)
 *
 * The bun-raw row is the ceiling on purpose: it does the minimum a forward can do - rewrite the
 * URL and pass the Request through. It strips no hop-by-hop headers, enforces no timeout, and
 * follows upstream redirects. The gap between it and the real proxies is the cost of correctness,
 * which is the number worth knowing.
 *
 * nifra imports the BUILT dist, not `@nifrajs/proxy` - the package's "bun" export condition
 * resolves to `src/`, which would benchmark live TypeScript instead of what `bun add` installs.
 * Same rule as bench/http/_nifra-app.ts.
 *
 *   bun run bench/proxy/serve-bun.ts <nifra|nifra-bare|hono|bun-raw> <port> <upstreamPort>
 */

const framework = process.argv[2]
const port = Number(process.argv[3])
const upstreamPort = Number(process.argv[4])

if (!Number.isInteger(port) || !Number.isInteger(upstreamPort)) {
  throw new Error(
    "usage: bun run bench/proxy/serve-bun.ts <nifra|nifra-bare|hono|bun-raw> <port> <upstream>",
  )
}

const upstream = `http://127.0.0.1:${upstreamPort}`

if (framework === "nifra") {
  const { server } = await import("../../packages/core/dist/server.js")
  const { createProxy } = await import("../../packages/proxy/dist/index.js")
  const app = server().mountFetch("/", createProxy({ upstream }))
  app.listen(port)
} else if (framework === "nifra-bare") {
  const { createProxy } = await import("../../packages/proxy/dist/index.js")
  const proxy = createProxy({ upstream })
  Bun.serve({ port, fetch: proxy })
} else if (framework === "hono") {
  const { Hono } = await import("hono")
  const { proxy } = await import("hono/proxy")
  const app = new Hono().all("/*", (c) => {
    const url = new URL(c.req.url)
    return proxy(`${upstream}${url.pathname}${url.search}`, c.req.raw)
  })
  Bun.serve({ port, fetch: app.fetch })
} else if (framework === "bun-raw") {
  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url)
      // `new Request(url, req)` is the clone-with-a-new-URL idiom - passing the Request as the
      // `init` bag instead throws a DOMException on a body-bearing method.
      return fetch(new Request(`${upstream}${url.pathname}${url.search}`, req))
    },
  })
} else {
  throw new Error(`unknown framework "${framework}" (nifra | nifra-bare | hono | bun-raw)`)
}

// Every import here is a dynamic `import()` inside a branch, so nothing marks this file a module -
// which would make the top-level awaits above a script-scope error.
export {}
