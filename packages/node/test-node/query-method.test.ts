/**
 * A QUERY route on Node over real sockets: Node's parser accepts the method, the body reaches the
 * route's schema, and a GET on the same path is still its own route.
 */

import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { server } from "@nifrajs/core"
import { method } from "@nifrajs/core/methods"
import { serve } from "@nifrajs/node"
import { t } from "@nifrajs/schema"

let url = ""
let stop: (() => Promise<void>) | undefined

before(async () => {
  const app = server()
    .get("/search", () => ({ via: "get" }))
    .use(
      method("QUERY", "/search", { body: t.object({ name: t.string() }) }, (c) => ({
        via: c.req.method,
        name: c.body.name,
      })),
    )
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  url = `http://127.0.0.1:${running.port}/search`
  stop = () => running.stop()
})

after(async () => {
  await stop?.()
})

const query = (body: string) =>
  fetch(url, { method: "QUERY", headers: { "content-type": "application/json" }, body })

test("a QUERY request reaches its route with its body", async () => {
  const response = await query('{"name":"nifra"}')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { via: "QUERY", name: "nifra" })
})

test("a QUERY body that fails the schema is a 422", async () => {
  const response = await query('{"name":1}')
  assert.equal(response.status, 422)
  await response.body?.cancel()
})

test("a GET on the same path is its own route", async () => {
  assert.deepEqual(await (await fetch(url)).json(), { via: "get" })
})
