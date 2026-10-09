/**
 * Node serves through lazy request sources, so the request an authentication stage accepted must be
 * the one response hooks receive, with and without an onRequest hook that replaces it.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { server } from "@nifrajs/core"
import { authenticated, isAuthenticatedRequest, rejected } from "@nifrajs/core/server"
import { serve } from "@nifrajs/node"

let base = ""
let rewriteBase = ""
const stops: Array<() => Promise<void>> = []

const build = (rewrite: boolean) =>
  server()
    .onRequest((req) => (rewrite ? new Request(req.url, { headers: req.headers }) : undefined))
    .onResponse((res, req) => {
      res.headers.set("x-authenticated", String(isAuthenticatedRequest(req)))
      return res
    })
    .authenticate({
      id: "service",
      run: (input) =>
        input.headers.get("x-service-key") === "k" ? authenticated("svc") : rejected(),
    })
    .get("/secret", () => ({ ok: true }))

before(async () => {
  const plain = await serve(build(false), { port: 0, hostname: "127.0.0.1" })
  const rewritten = await serve(build(true), { port: 0, hostname: "127.0.0.1" })
  base = `http://127.0.0.1:${plain.port}`
  rewriteBase = `http://127.0.0.1:${rewritten.port}`
  stops.push(plain.stop, rewritten.stop)
})
after(async () => {
  for (const stop of stops) await stop()
})

for (const [label, origin] of [
  ["lazy source", () => base],
  ["replaced request", () => rewriteBase],
] as const) {
  test(`${label}: response hooks see the authenticated request`, async () => {
    const authed = await fetch(`${origin()}/secret`, { headers: { "x-service-key": "k" } })
    assert.equal(authed.status, 200)
    assert.equal(authed.headers.get("x-authenticated"), "true")
    const anon = await fetch(`${origin()}/secret`)
    assert.equal(anon.status, 401)
    assert.equal(anon.headers.get("x-authenticated"), "false")
  })
}
