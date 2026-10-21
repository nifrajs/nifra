import assert from "node:assert/strict"
import { test } from "node:test"
import { makeWorstNifraApp } from "../http/worst-case/_app.ts"

test("the generic stress fixture excludes both closed-shape fusion plans", async () => {
  const closed = makeWorstNifraApp(false)
  const generic = makeWorstNifraApp(true)
  // Inspect the compiled plan so a future optimizer cannot silently turn this fixture into a fast lane.
  for (const app of [closed, generic]) {
    const routes = app.catalog.entries().filter((route) => route.path !== "/health")
    assert.equal(routes.length, 2)
    for (const route of routes) {
      assert.equal(route.entry.beforeHandle.length, app === generic ? 2 : 1)
      assert.equal(route.entry.execution.fusedLane === undefined, app === generic)
    }
    const headers = { "x-req-id": "probe", "content-type": "application/json" }
    const get = await app.fetch(
      new Request("http://x/orgs/acme/projects/apollo/tasks/42?verbose=1&trace=trace", { headers }),
    )
    assert.equal(get.status, 200)
    assert.equal(get.headers.get("x-request-id"), "probe")
    assert.deepEqual(await get.json(), { org: "acme", proj: "apollo", id: "42", verbose: "1" })
    const post = await app.fetch(
      new Request("http://x/orgs/acme/projects/apollo/tasks", {
        method: "POST",
        headers,
        body: JSON.stringify({ items: [{ title: "first", done: false, priority: 1, notes: "" }] }),
      }),
    )
    assert.equal(post.status, 200)
    assert.equal(post.headers.get("x-count"), "1")
    assert.equal((await post.json()).first, "first")
    const blocked = await app.fetch(
      new Request("http://x/orgs/acme/projects/apollo/tasks/42?verbose=1&trace=trace", {
        headers: { ...headers, "x-block": "1" },
      }),
    )
    assert.equal(blocked.status, 403)
    await blocked.text()
  }
})
