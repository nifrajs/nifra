import { afterEach, expect, test } from "bun:test"
import { type RunningServer, server } from "../src/index.ts"
import { websocket } from "../src/ws.ts"

let running: RunningServer | undefined
afterEach(() => {
  running?.stop(true)
  running = undefined
})

const handshake = {
  upgrade: "websocket",
  connection: "Upgrade",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
}

// A stray handshake to an HTTP route is answered by that route; per-request hooks such as a rate
// limiter must count it once, not once for the socket check and again for the HTTP answer.
for (const mode of ["sync", "async"] as const) {
  test(`${mode} onRequest hooks run once for a handshake no socket route takes`, async () => {
    const seen: string[] = []
    const responded: string[] = []
    const app = server()
      .use(websocket())
      .onRequest((request) => {
        seen.push(new URL(request.url).pathname)
        const rewritten =
          new URL(request.url).pathname === "/old"
            ? new Request(new URL("/plain", request.url).href, { headers: request.headers })
            : undefined
        return mode === "sync" ? rewritten : Promise.resolve(rewritten)
      })
      .onResponse((response, request) => {
        responded.push(new URL(request.url).pathname)
        return response
      })
      .get("/plain", () => ({ ok: true }))
      .ws("/chat", { message() {} })
    running = app.listen(0, { hostname: "127.0.0.1" })
    const base = `http://127.0.0.1:${running.port}`

    const plain = await fetch(`${base}/plain`, { headers: handshake })
    expect(plain.status).toBe(200)
    expect(seen).toEqual(["/plain"])

    // The hooks' rewrite still decides the HTTP route, and response hooks see the rewritten request.
    const rewritten = await fetch(`${base}/old`, { headers: handshake })
    expect(rewritten.status).toBe(200)
    expect(await rewritten.json()).toEqual({ ok: true })
    expect(seen).toEqual(["/plain", "/old"])
    expect(responded).toEqual(["/plain", "/plain"])

    // A plain request with no handshake is unaffected.
    await fetch(`${base}/plain`)
    expect(seen).toEqual(["/plain", "/old", "/plain"])
  })
}
