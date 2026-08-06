/**
 * The A/B app for the static response-header tier: a bare `GET /` behind `securityHeaders()`,
 * declared two ways.
 *
 *   static - the shipped middleware, which DECLARES its five fixed headers. No response hook is
 *            registered, so the app keeps Bun's fused native routes and Node's direct writer.
 *   hook   - the same five headers written by an `onResponseHeaders` hook: what `securityHeaders()`
 *            was before the tier existed, and what any request-dependent header middleware still
 *            costs.
 *
 * Both variants must ship the identical wire (pinned by the parity suites in packages/core,
 * packages/node, and packages/deno) - so the whole delta is what registering a response hook costs.
 *
 * The `server` VALUE import points at built `dist/`, not `@nifrajs/core`: the "bun" export condition
 * resolves to `src/*.ts`, and this bench has to measure the artifact a real install runs (see
 * _nifra-app.ts for the measured source-vs-dist difference).
 */
import { server } from "../../packages/core/dist/server.js"
import { securityHeaders } from "../../packages/middleware/dist/index.js"

export type Variant = "static" | "hook"

const HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "no-referrer"],
  ["strict-transport-security", "max-age=31536000; includeSubDomains"],
  ["content-security-policy", "default-src 'self'"],
]

const OPTIONS = {
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
  contentSecurityPolicy: "default-src 'self'",
} as const

export function makeStaticHeadersApp(variant: Variant) {
  const app = server()
  if (variant === "static") {
    app.use(securityHeaders(OPTIONS))
  } else {
    app.onResponseHeaders((headers) => {
      for (const [name, value] of HEADERS) headers.set(name, value)
    })
  }
  return app.get("/", () => ({ hello: "world" })).get("/users/:id", (c) => ({ id: c.params.id }))
}

export function variantOf(raw: string | undefined): Variant {
  if (raw === "static" || raw === "hook") return raw
  throw new Error(`usage: <static|hook> <port> (got ${String(raw)})`)
}
