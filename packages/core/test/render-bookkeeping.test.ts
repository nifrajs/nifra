import { expect, test } from "bun:test"

test("response bookkeeping stays lazy until hooks or an in-process reader need it", async () => {
  // The resident-body flag is process-wide and irreversible; exercise its cold state in isolation.
  const script = `
    import assert from "node:assert/strict"
    import { server, silentLogger } from SERVER_MODULE
    import { hasResidentBody, recordResidentBodies } from MOUNT_MODULE
    const request = (path) => new Request("http://bookkeeping.test" + path)
    const make = () => server({ logger: silentLogger })
      .beforeHandle(() => undefined)
      .beforeHandle(() => undefined)
      .afterHandle((result) => result)
      .get("/plain", () => ({ ok: true }))
      .get("/headers", (c) => {
        c.set.headers["x-value"] = "one"
        return { ok: true }
      })
      .get("/cookies", (c) => {
        c.set.cookie("sid", "value")
        c.set.status = 201
        return { ok: true }
      })
    const app = make()
    for (const path of ["/plain", "/headers", "/cookies"]) {
      const response = await app.fetch(request(path))
      assert.equal(hasResidentBody(response), false)
      assert.equal(response.status, path === "/cookies" ? 201 : 200)
      assert.deepEqual(await response.json(), { ok: true })
      if (path === "/headers") assert.equal(response.headers.get("x-value"), "one")
      if (path === "/cookies") assert.match(response.headers.get("set-cookie"), /sid=value/)
    }
    const hooked = make().onResponse((response) => {
      assert.equal(hasResidentBody(response), true)
      response.headers.set("x-hook", "seen")
      return response
    })
    const observed = await hooked.fetch(request("/headers"))
    assert.equal(observed.headers.get("x-hook"), "seen")
    assert.deepEqual(await observed.json(), { ok: true })
    const cached = await app.fetch(request("/headers"))
    assert.equal(hasResidentBody(cached), false)
    const reuse = server({ logger: silentLogger })
      .onResponse((response, req) => {
        response.headers.set("x-user", req.headers.get("x-user") ?? "none")
        return response
      })
      .get("/cached", () => cached)
    const first = await reuse.fetch(new Request("http://bookkeeping.test/cached", { headers: { "x-user": "alice" } }))
    assert.equal(first.headers.get("x-user"), "alice")
    assert.deepEqual(await first.json(), { ok: true })
    const second = await reuse.fetch(new Request("http://bookkeeping.test/cached", { headers: { "x-user": "bob" } }))
    assert.equal(second.status, 500)
    assert.notEqual(second.headers.get("x-user"), "alice")
    await second.text()
    recordResidentBodies()
    for (const path of ["/plain", "/headers", "/cookies"]) {
      const response = await app.fetch(request(path))
      assert.equal(hasResidentBody(response), true)
      assert.deepEqual(await response.json(), { ok: true })
    }
`
    .replace("SERVER_MODULE", JSON.stringify(new URL("../src/index.ts", import.meta.url).href))
    .replace("MOUNT_MODULE", JSON.stringify(new URL("../src/mount.ts", import.meta.url).href))
  const child = Bun.spawn([process.execPath, "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
})
