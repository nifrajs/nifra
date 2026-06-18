/**
 * Raw `Bun.serve` throughput target — the ceiling our framework's per-request
 * overhead is measured against. Our v1 goal (parity within ~10% of Elysia) is
 * really a statement about how thin our layer over this is.
 *
 * Run it, then load-test with an external client (in-process fetch would
 * measure the client too, undercounting the server):
 *
 *   bun run bench/http/baseline-server.ts
 *   oha -z 10s http://localhost:3000/          # or:
 *   autocannon -d 10 -c 64 http://localhost:3000/
 *
 * Phase 1 adds the same load test pointed at the framework + at Elysia/Hono so
 * the three are compared on identical hardware and payload.
 */
const server = Bun.serve({
  port: 3000,
  fetch() {
    return Response.json({ hello: "world" })
  },
})

console.log(`raw Bun.serve listening on ${server.url}`)
