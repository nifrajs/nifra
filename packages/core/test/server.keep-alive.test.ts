import { expect, test } from "bun:test"
import { server } from "../src/index.ts"

/**
 * Connection reuse, over a raw socket.
 *
 * The suite's preload (`scripts/test-preload.ts`) forces `Connection: close` on every loopback `fetch`
 * as a mitigation for an unreproduced flake. That has a cost nobody was tracking: from the moment it
 * landed, NOTHING in the suite sent two requests down one connection - the single most common thing a
 * real client does, since every browser and every HTTP agent pools connections by default. A server
 * that mishandled the second request on a socket would have looked perfectly healthy here.
 *
 * These tests speak HTTP/1.1 over `Bun.connect` rather than `fetch`, which is what puts them outside
 * the preload's reach. They are deliberately not routed through the wrapper: using `fetch` would test
 * the mitigation, not the server.
 */

/** Send raw bytes on one socket and collect everything the server writes back. */
async function converse(port: number, requests: readonly string[]): Promise<string> {
  let buffer = ""
  let onData: (() => void) | undefined
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, chunk) {
        buffer += new TextDecoder().decode(chunk)
        onData?.()
      },
    },
  })
  try {
    for (const request of requests) {
      const before = buffer.length
      socket.write(request)
      // Wait for this request's response before sending the next, so the assertions can attribute
      // each body to its request rather than racing two writes into one buffer.
      await new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, 5000)
        onData = () => {
          if (buffer.length > before && /\r\n\r\n/.test(buffer.slice(before))) {
            clearTimeout(deadline)
            resolve()
          }
        }
        onData()
      })
    }
    return buffer
  } finally {
    onData = undefined
    socket.end()
  }
}

const get = (path: string): string =>
  `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`

test("two requests on ONE connection both get their own response", async () => {
  const app = server()
    .get("/first", () => ({ which: "first" }))
    .get("/second", () => ({ which: "second" }))
  const instance = app.listen(0)
  try {
    const conversation = await converse(instance.port, [get("/first"), get("/second")])
    // Both bodies arrived, in order, on a socket that was never closed between them.
    expect(conversation).toContain('{"which":"first"}')
    expect(conversation).toContain('{"which":"second"}')
    expect(conversation.indexOf('"first"')).toBeLessThan(conversation.indexOf('"second"'))
    // Two responses, not one - a server that closed after the first would yield a single status line.
    expect(conversation.match(/HTTP\/1\.1 200/g)?.length).toBe(2)
  } finally {
    instance.stop()
  }
})

test("route params and query stay correct on a reused connection", async () => {
  // The failure this guards against is state leaking between requests that share a socket - the second
  // request seeing the first's params, which no single-request test can observe.
  const app = server().get("/users/:id", (c) => ({ id: c.params.id, q: c.query.get("q") }))
  const instance = app.listen(0)
  try {
    const conversation = await converse(instance.port, [
      get("/users/alice?q=one"),
      get("/users/bob?q=two"),
    ])
    expect(conversation).toContain('{"id":"alice","q":"one"}')
    expect(conversation).toContain('{"id":"bob","q":"two"}')
    expect(conversation).not.toContain('{"id":"alice","q":"two"}')
  } finally {
    instance.stop()
  }
})

test("a 404 on a reused connection does not poison the next request", async () => {
  const app = server().get("/ok", () => ({ ok: true }))
  const instance = app.listen(0)
  try {
    const conversation = await converse(instance.port, [get("/nope"), get("/ok")])
    expect(conversation).toContain("404")
    expect(conversation).toContain('{"ok":true}')
  } finally {
    instance.stop()
  }
})
