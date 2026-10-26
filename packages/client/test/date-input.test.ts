import { expect, test } from "bun:test"
import { inProcessClient } from "@nifrajs/client"
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"

const AT = new Date("2026-10-25T12:00:00.000Z")

test("a Date the client sends in a body, a query or a path reaches the handler as a Date", async () => {
  const seen: unknown[] = []
  const app = server()
    .post("/events", { body: t.object({ at: t.date() }) }, (c) => {
      seen.push(c.body.at)
      return { at: c.body.at }
    })
    .get("/events", { query: t.query({ from: t.date(), to: t.optional(t.date()) }) }, (c) => {
      seen.push(c.query.from)
      return { from: c.query.from }
    })
    .get("/days/:day", { params: t.object({ day: t.date() }) }, (c) => {
      seen.push(c.params.day)
      return { day: c.params.day }
    })
  const api = inProcessClient(app)
  const later = new Date(AT.getTime() + 1)
  expect(await api.events.post({ at: AT })).toMatchObject({
    status: 200,
    data: { at: AT.toISOString() },
  })
  expect(await api.events.get({ query: { from: later } })).toMatchObject({
    status: 200,
    data: { from: later.toISOString() },
  })
  expect(await api.days({ day: AT.toISOString() }).get()).toMatchObject({ status: 200 })
  expect(seen).toEqual([AT, later, AT])
  expect(seen.every((value) => value instanceof Date)).toBe(true)
  expect(await api.events.get({ query: { from: new Date(Number.NaN) } })).toMatchObject({
    status: 422,
  })
})
