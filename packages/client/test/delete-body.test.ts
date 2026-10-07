import { expect, test } from "bun:test"
import { inProcessClient } from "@nifrajs/client"
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"

test("a DELETE sends options.body as JSON to a route with a body schema", async () => {
  const app = server()
    .delete("/item", { body: t.object({ id: t.string() }) }, (c) => ({ deleted: c.body.id }))
    .delete("/plain", (c) => ({ type: c.req.headers.get("content-type") }))
  const api = inProcessClient(app)
  const removed = await api.item.delete({ body: { id: "123" } })
  expect(removed).toMatchObject({ ok: true, status: 200, data: { deleted: "123" } })
  const plain = await api.plain.delete()
  expect(plain).toMatchObject({ ok: true, data: { type: null } })
})
