/**
 * Deno server for the static-response-header A/B, through `@nifrajs/deno` (see
 * _static-headers-app.ts).
 *
 *   deno run --allow-net --allow-env --no-check bench/http/serve-deno-static-headers.ts <static|hook> <port>
 */
import { server } from "../../packages/core/dist/index.js"
import { serve } from "../../packages/deno/src/index.ts"
import { securityHeaders } from "../../packages/middleware/dist/index.js"

const variant = Deno.args[0]
const port = Number(Deno.args[1])
if ((variant !== "static" && variant !== "hook") || !Number.isInteger(port)) {
  throw new Error(
    "usage: deno run --allow-net --allow-env --no-check bench/http/serve-deno-static-headers.ts <static|hook> <port>",
  )
}

// The app is rebuilt here rather than imported from _static-headers-app.ts: that module imports the
// Bun/Node-flavored dist entry (`dist/server.js`), while Deno's own bench servers import
// `dist/index.js` - the entry a `npm:@nifrajs/core` install resolves. Same middleware, same headers.
const HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "no-referrer"],
  ["strict-transport-security", "max-age=31536000; includeSubDomains"],
  ["content-security-policy", "default-src 'self'"],
]

const app = server()
if (variant === "static") {
  app.use(
    securityHeaders({
      hsts: { maxAge: 31_536_000, includeSubDomains: true },
      contentSecurityPolicy: "default-src 'self'",
    }),
  )
} else {
  app.onResponseHeaders((headers: { set: (name: string, value: string) => void }) => {
    for (const [name, value] of HEADERS) headers.set(name, value)
  })
}
app
  .get("/", () => ({ hello: "world" }))
  .get("/users/:id", (c: { params: { id: string } }) => ({
    id: c.params.id,
  }))

await serve(app, { port })
