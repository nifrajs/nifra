/**
 * Production hardening via composable middleware: security headers, CORS, and a rate
 * limit — all applied with `app.use()`.
 *
 *   bun run examples/hardened.ts
 */
import { server } from "@nifrajs/core/server"
import { cors, MemoryStore, rateLimit, securityHeaders } from "@nifrajs/middleware"

const app = server()
  .use(securityHeaders())
  .use(cors({ origin: "*" }))
  .use(rateLimit({ store: new MemoryStore(), max: 2, windowMs: 60_000, key: () => "demo" }))
  .get("/", () => ({ ok: true }))

// Three requests: the third trips the limit (max: 2 per window).
for (let i = 1; i <= 3; i++) {
  const res = await app.fetch(
    new Request("http://localhost/", { headers: { origin: "https://app.example.com" } }),
  )
  console.log(
    `req ${i} -> ${res.status}`,
    `| ratelimit-remaining: ${res.headers.get("ratelimit-remaining")}`,
    `| x-frame-options: ${res.headers.get("x-frame-options")}`,
    `| allow-origin: ${res.headers.get("access-control-allow-origin")}`,
  )
}
