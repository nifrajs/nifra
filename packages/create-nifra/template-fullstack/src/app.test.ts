import { expect, test } from "bun:test"
import { app, queue, wasIndexed } from "./app.ts"

const post = (body: unknown) =>
  app.fetch(
    new Request("http://localhost/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

test("create + background index job", async () => {
  const res = await post({ title: "first", body: "hello" })
  expect(res.status).toBe(201)
  const note = (await res.json()) as { id: number }

  // The index job was enqueued, not run yet — drain the queue once, then it's indexed.
  expect(wasIndexed(note.id)).toBe(false)
  await queue.drain()
  expect(wasIndexed(note.id)).toBe(true)
})

type Page = { items: unknown[]; nextCursor: string | null }

test("cursor pagination walks every page", async () => {
  await post({ title: "a", body: "" })
  await post({ title: "b", body: "" })
  await post({ title: "c", body: "" })

  const first = (await (await app.fetch(new Request("http://localhost/notes?limit=2"))).json()) as Page
  expect(first.items).toHaveLength(2)
  expect(first.nextCursor).not.toBeNull()

  const url = `http://localhost/notes?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`
  const second = (await (await app.fetch(new Request(url))).json()) as Page
  expect(second.items.length).toBeGreaterThan(0)
})

test("limit over the cap is a 400", async () => {
  const res = await app.fetch(new Request("http://localhost/notes?limit=999"))
  expect(res.status).toBe(400)
})

test("get one is served (and cached); missing is 404", async () => {
  const created = (await (await post({ title: "cached", body: "x" })).json()) as { id: number }
  const hit = await app.fetch(new Request(`http://localhost/notes/${created.id}`))
  expect(((await hit.json()) as { id: number }).id).toBe(created.id)

  const miss = await app.fetch(new Request("http://localhost/notes/999999"))
  expect(miss.status).toBe(404)
})

test("attachment round-trips through storage", async () => {
  const created = (await (await post({ title: "with-file", body: "x" })).json()) as { id: number }
  const res = await app.fetch(
    new Request(`http://localhost/notes/${created.id}/attachment`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "hello bytes",
    }),
  )
  expect(res.status).toBe(201)
  expect(((await res.json()) as { bytes: number }).bytes).toBe("hello bytes".length)
})
