/** WebSocket serving on the engine, with the fixtures the Bun, Node and Deno suites run. */

import assert from "node:assert/strict"
import { test } from "node:test"
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { WebSocket as WsClient } from "ws"
import {
  closeArgsAnswers,
  closeArgsRoute,
  closeReportRoute,
  closeReports,
  closeWithoutCode,
  FORBIDDEN_CLOSES,
  REPORT_CAP,
  SERVER_CLOSE_REPORTS,
} from "../../core/test/ws-close-args.ts"
import { firstContractFrame, sendContractApp } from "../../core/test/ws-send-contract.ts"
import { publishFeedApp, publishRoundTrip } from "../../node/test/ws-publish-fixture.ts"
import { type EngineSocket, mayServeSockets, payloadCeiling, serve } from "../src/index.ts"
import { parseHead, raw } from "./support.ts"

const HANDSHAKE =
  "connection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n"

const open = (socket: WsClient): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
  })

test("a close RFC 6455 forbids throws a RangeError and leaves the socket open", async () => {
  const running = await serve(closeArgsRoute(server().use(websocket())), {
    port: 0,
    hostname: "127.0.0.1",
  })
  try {
    assert.deepEqual(await closeArgsAnswers(running.port), {
      answers: FORBIDDEN_CLOSES.map(() => "range"),
      closed: { code: 4000, reason: "ok" },
    })
    assert.deepEqual(await closeWithoutCode(running.port), { code: 1000, reason: "" })
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("close is given the server's own close, and 1009 for a message over the route's cap", async () => {
  const app = server({ wsMaxPayloadBytes: REPORT_CAP }).use(websocket())
  const next = closeReportRoute(app)
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    assert.deepEqual(await closeReports(running.port, next), [...SERVER_CLOSE_REPORTS])
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a frame the route's sendSchema refuses never leaves, and error() hears of it", async () => {
  const contract = sendContractApp(server().use(websocket()))
  const running = await serve(contract.app, { port: 0, hostname: "127.0.0.1" })
  try {
    assert.equal(await firstContractFrame(running.port), JSON.stringify({ ok: true }))
    assert.equal(contract.errors.length, 1)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a publish reaches every subscriber byte for byte, in order", async () => {
  const feed = publishFeedApp(server().use(websocket()))
  const running = await serve(feed.app, { port: 0, hostname: "127.0.0.1" })
  try {
    const { got, expected } = await publishRoundTrip(feed, running.port)
    assert.deepEqual(got, expected)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("text arrives as a string, binary as a Uint8Array, and each is echoed in kind", async () => {
  const seen: string[] = []
  const app = server()
    .use(websocket())
    .ws("/echo", {
      message: (ws, data) => {
        seen.push(typeof data === "string" ? "text" : data.constructor.name)
        ws.send(data)
      },
    })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  const socket = new WsClient(`ws://127.0.0.1:${running.port}/echo`)
  try {
    await open(socket)
    const frames: Array<[string | number[], boolean]> = []
    const done = new Promise<void>((resolve) =>
      socket.on("message", (data, isBinary) => {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a binary, unfragmented ws frame arrives as one Buffer
        frames.push([isBinary ? [...Buffer.from(data as Buffer)] : data.toString(), isBinary])
        if (frames.length === 2) resolve()
      }),
    )
    socket.send("hello")
    socket.send(Buffer.from([1, 2, 3]), { binary: true })
    await done
    assert.deepEqual(seen, ["text", "Uint8Array"])
    assert.equal(frames[0]?.[0], "hello")
    assert.equal(frames[0]?.[1], false)
    assert.deepEqual(frames[1]?.[0], [1, 2, 3])
    assert.equal(frames[1]?.[1], true)
  } finally {
    socket.terminate()
    await running.stop({ drainMs: 50 })
  }
})

test("a guard's rejection answers the handshake with its own status and headers", async () => {
  const app = server()
    .use(websocket())
    .ws("/private", {
      upgrade: () => new Response("no", { status: 401, headers: { "x-guard": "yes" } }),
      message: () => {},
    })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const text = await raw(
      running.port,
      `GET /private HTTP/1.1\r\nhost: x\r\n${HANDSHAKE}\r\n`,
      (r) => r.endsWith("no"),
    )
    const parsed = parseHead(text)
    assert.equal(parsed.status, 401)
    assert.equal(parsed.headers.get("x-guard")?.[0], "yes")
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a handshake for a path with no socket route is answered by the HTTP route", async () => {
  const app = server()
    .use(websocket())
    .get("/plain", () => ({ plain: true }))
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const text = await raw(
      running.port,
      `GET /plain HTTP/1.1\r\nhost: x\r\n${HANDSHAKE}\r\n`,
      (r) => r.includes("}"),
    )
    const parsed = parseHead(text)
    assert.equal(parsed.status, 200)
    assert.match(parsed.body, /plain/)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a handshake the engine cannot upgrade is a 400", async () => {
  const app = server()
    .use(websocket())
    .ws("/live", { message: () => {} })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const text = await raw(
      running.port,
      // Version 8: not a handshake the engine upgrades.
      "GET /live HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 8\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      (r) => r.includes("\r\n\r\n"),
    )
    assert.ok([400, 426].includes(parseHead(text).status))
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a plain fetch handler cannot serve sockets: the handshake is refused with 501", async () => {
  const running = await serve(
    { fetch: () => new Response("ok") },
    { port: 0, hostname: "127.0.0.1" },
  )
  try {
    const text = await raw(running.port, `GET / HTTP/1.1\r\nhost: x\r\n${HANDSHAKE}\r\n`, (r) =>
      r.includes("}"),
    )
    assert.equal(parseHead(text).status, 501)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("stop() closes open sockets with 1001, and a socket's close callback runs once", async () => {
  const closes: Array<[number, string]> = []
  const app = server()
    .use(websocket())
    .ws("/live", {
      open: (ws) => ws.subscribe("room"),
      close: (_ws, code, reason) => {
        closes.push([code, reason])
      },
    })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  const socket = new WsClient(`ws://127.0.0.1:${running.port}/live`)
  await open(socket)
  const clientClose = new Promise<[number, string]>((resolve) =>
    socket.once("close", (code, reason) => resolve([code, reason.toString()])),
  )
  await running.stop({ drainMs: 2000 })
  assert.deepEqual(await clientClose, [1001, "server shutting down"])
  assert.deepEqual(closes, [[1001, "server shutting down"]])
})

test("a handler that throws reaches error() and never ends the connection", async () => {
  const errors: unknown[] = []
  const app = server()
    .use(websocket())
    .ws("/boom", {
      message: (ws, data) => {
        if (data === "boom") throw new Error("boom")
        ws.send("alive")
      },
      error: (_ws, error) => {
        errors.push(error)
      },
    })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  const socket = new WsClient(`ws://127.0.0.1:${running.port}/boom`)
  try {
    await open(socket)
    const reply = new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(data.toString())),
    )
    socket.send("boom")
    socket.send("ping")
    assert.equal(await reply, "alive")
    assert.equal(errors.length, 1)
  } finally {
    socket.terminate()
    await running.stop({ drainMs: 50 })
  }
})

test("ws.raw names the socket and what the engine kept of its handshake", async () => {
  const seen: Array<{ id: number; query: string; auth: string | null; ip: string | undefined }> = []
  const app = server()
    .use(websocket())
    .ws("/who", {
      open: (ws) => {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: on this transport `raw` is the EngineSocket handle
        const raw = ws.raw as EngineSocket
        seen.push({
          id: raw.id,
          query: raw.query(),
          auth: raw.headers().get("x-token"),
          ip: raw.remoteAddress(),
        })
      },
    })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  const socket = new WsClient(`ws://127.0.0.1:${running.port}/who?room=7`, {
    headers: { "x-token": "abc" },
  })
  try {
    await open(socket)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.query, "room=7")
    assert.equal(seen[0]?.auth, "abc")
    assert.match(seen[0]?.ip ?? "", /127\.0\.0\.1$/)
  } finally {
    socket.terminate()
    await running.stop({ drainMs: 50 })
  }
})

test("the engine's message cap follows the app's wsMaxPayloadBytes, and 1009 carries its reason", async () => {
  const closes: Array<[number, string]> = []
  const app = server({ wsMaxPayloadBytes: 1024 })
    .use(websocket())
    .ws("/small", {
      close: (_ws, code, reason) => {
        closes.push([code, reason])
      },
    })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  const socket = new WsClient(`ws://127.0.0.1:${running.port}/small`)
  try {
    await open(socket)
    const clientClosed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    )
    socket.send("x".repeat(2048))
    assert.equal(await clientClosed, 1009)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(closes, [[1009, "message too large"]])
  } finally {
    socket.terminate()
    await running.stop({ drainMs: 50 })
  }
})

test("a mounted app's cap raises the listener's, and its own routes are held to their own", async () => {
  const big = server({ wsMaxPayloadBytes: 8192 })
    .use(websocket())
    .ws("/big", {
      message: (ws, data) => ws.send(`len ${typeof data === "string" ? data.length : data.length}`),
    })
  const small = server({ wsMaxPayloadBytes: 256 })
    .use(websocket())
    .ws("/small", {
      message: (ws) => ws.send("ok"),
    })
  const root = server()
    .mount({ path: "/a", app: big, stripPrefix: true })
    .mount({ path: "/b", app: small, stripPrefix: true })
  const running = await serve(root, { port: 0, hostname: "127.0.0.1" })
  try {
    const bigSocket = new WsClient(`ws://127.0.0.1:${running.port}/a/big`)
    await open(bigSocket)
    const reply = new Promise<string>((resolve) =>
      bigSocket.once("message", (data) => resolve(data.toString())),
    )
    bigSocket.send("y".repeat(4000))
    assert.equal(await reply, "len 4000")
    bigSocket.terminate()

    const smallSocket = new WsClient(`ws://127.0.0.1:${running.port}/b/small`)
    await open(smallSocket)
    const closed = new Promise<number>((resolve) =>
      smallSocket.once("close", (code) => resolve(code)),
    )
    smallSocket.send("z".repeat(1000))
    assert.equal(await closed, 1009)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("the listener's cap is the largest among the app and the mounted apps that serve sockets", () => {
  const socketApp = (cap: number) =>
    server({ wsMaxPayloadBytes: cap })
      .use(websocket())
      .ws("/s", { message: () => {} })
  const silent = server({ wsMaxPayloadBytes: 1 << 20 })
  assert.equal(payloadCeiling(server()), undefined)
  assert.equal(payloadCeiling(socketApp(2048)), 2048)
  const root = server({ wsMaxPayloadBytes: 512 })
    .use(websocket())
    .ws("/r", { message: () => {} })
    .mount({ path: "/a", app: socketApp(8192), stripPrefix: true })
    .mount({ path: "/b", app: socketApp(256), stripPrefix: true })
    .mount({ path: "/c", app: silent, stripPrefix: true })
  assert.equal(payloadCeiling(root), 8192)
})

const socketApp = () =>
  server()
    .use(websocket())
    .ws("/s", { message: () => {} })
const plainApp = () =>
  server()
    .use(websocket())
    .get("/p", () => ({ p: 1 }))

test("an app skips the Upgrade read only when nothing in it can take a handshake", () => {
  assert.equal(mayServeSockets(socketApp()), true)
  assert.equal(mayServeSockets(plainApp()), false)
  assert.equal(mayServeSockets(server().mount({ path: "/a", app: socketApp() })), true)
  assert.equal(mayServeSockets(server().mount({ path: "/a", app: plainApp() })), false)
  assert.equal(
    mayServeSockets(server().mount({ path: "/a", app: { fetch: () => new Response("x") } })),
    false,
  )
  assert.equal(
    mayServeSockets(
      server().mount({
        path: "/a",
        app: { fetch: () => new Response("x"), resolveWebSocketUpgrade: () => ({ kind: "pass" }) },
      }),
    ),
    true,
  )
  assert.equal(mayServeSockets({ wsRoutes: "?" }), true)
})

test("a handshake to an app with no socket routes is answered as a plain GET, and one with routes still upgrades", async () => {
  const none = await serve(plainApp(), { port: 0, hostname: "127.0.0.1" })
  const some = await serve(socketApp(), { port: 0, hostname: "127.0.0.1" })
  try {
    const plain = parseHead(
      await raw(none.port, `GET /p HTTP/1.1\r\nhost: x\r\n${HANDSHAKE}\r\n`, (r) =>
        r.includes("}"),
      ),
    )
    assert.equal(plain.status, 200)
    const socket = new WsClient(`ws://127.0.0.1:${some.port}/s`)
    await open(socket)
    socket.close()
  } finally {
    await none.stop({ drainMs: 50 })
    await some.stop({ drainMs: 50 })
  }
})
