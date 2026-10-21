/** The Node dev upgrade path's refusals, written straight to the raw socket. */
import { expect, test } from "bun:test"
import { server as nifra } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import {
  type UpgradableApp,
  type UpgradeSocket,
  upgradeOnNode,
  wsServerFrom,
} from "../src/internal/dev-websocket.ts"
import { roomApp } from "./dev-websocket-fixture.ts"

function rawSocket(): UpgradeSocket & { written: string; destroyed: boolean } {
  const socket = {
    written: "",
    destroyed: false,
    write(chunk: string): boolean {
      socket.written += chunk
      return true
    },
    destroy(): void {
      socket.destroyed = true
    },
    on(): unknown {
      return socket
    },
  }
  return socket
}

const handshake = (path: string): Request =>
  new Request(`http://127.0.0.1${path}`, {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    },
  })

test("a ws server loads only from a module that has one", async () => {
  expect(await wsServerFrom("nifra-no-such-module")).toBeUndefined()
  expect(await wsServerFrom("node:path")).toBeUndefined()
  expect(await wsServerFrom("ws")).toBeDefined()
})

test("a guard that throws is a 500 on the raw socket, which then closes", async () => {
  const socket = rawSocket()
  const app = {
    resolveWebSocketUpgrade: async (): Promise<never> => {
      throw new Error("guard broke")
    },
  }
  expect(await upgradeOnNode(app, handshake("/room"), {}, socket, undefined)).toBe(true)
  expect(socket.written).toStartWith("HTTP/1.1 500 ")
  expect(socket.written).toEndWith("\r\n\r\ninternal_error")
  expect(socket.destroyed).toBe(true)
})

test("an accepted socket with no `ws` package gets a 501 that says what to install", async () => {
  const socket = rawSocket()
  const app = roomApp(nifra().use(websocket()))
  const answered = await upgradeOnNode(
    app,
    handshake("/room"),
    {},
    socket,
    undefined,
    async () => undefined,
  )
  expect(answered).toBe(true)
  expect(socket.written).toStartWith("HTTP/1.1 501 ")
  expect(socket.written).toContain("install `ws`")
})

test("a refusal keeps its own headers and frames its body once", async () => {
  const socket = rawSocket()
  const response = new Response("denied", {
    status: 403,
    headers: { "x-reason": "guard", "content-length": "999", connection: "keep-alive" },
  })
  const app: UpgradableApp = { resolveWebSocketUpgrade: async () => ({ kind: "reject", response }) }
  expect(await upgradeOnNode(app, handshake("/room"), {}, socket, undefined)).toBe(true)
  const [head, body] = socket.written.split("\r\n\r\n")
  expect(head?.split("\r\n")).toEqual([
    "HTTP/1.1 403 Refused",
    "x-reason: guard",
    "content-length: 6",
    "connection: close",
  ])
  expect(body).toBe("denied")
})

test("an accepted socket's frames, close and errors reach the route through the view", async () => {
  const heard: string[] = []
  const app = nifra()
    .use(websocket())
    .ws("/room", {
      open: (ws) => ws.send("hello"),
      message: (ws, data) => {
        heard.push(String(data))
        if (data === "bye") ws.close(4000, "bye")
        else ws.send(`echo:${String(data)}`)
      },
      close: (_ws, code) => {
        heard.push(`closed:${code}`)
      },
    })
  const listeners = new Map<string, (...args: never[]) => void>()
  const sent: unknown[] = []
  let closedWith: number | undefined
  const fake = {
    readyState: 1,
    send(data: unknown): void {
      sent.push(data)
    },
    close(code?: number): void {
      closedWith = code
      fake.readyState = 3
    },
    on(event: string, listener: (...args: never[]) => void): void {
      listeners.set(event, listener)
    },
  }
  const fire = (event: string, ...args: unknown[]): void => {
    const listener = listeners.get(event)
    if (listener !== undefined) Reflect.apply(listener, undefined, args)
  }
  const errors: (() => void)[] = []
  const socket = {
    ...rawSocket(),
    on: (_event: "error", listener: () => void) => errors.push(listener),
  }
  const wsServer = async () => ({
    handleUpgrade: (
      _req: unknown,
      _socket: unknown,
      _head: unknown,
      done: (ws: typeof fake) => void,
    ) => done(fake),
  })
  expect(await upgradeOnNode(app, handshake("/room"), {}, socket, undefined, wsServer)).toBe(true)
  // A reset while the guard ran is swallowed rather than ending the process.
  for (const listener of errors) listener()
  fire("message", new TextEncoder().encode("hi"), false)
  fire("error", new Error("peer reset"))
  fire("message", "bye", false)
  fire("close", 4000, new TextEncoder().encode("bye"))
  expect(sent).toEqual(["hello", "echo:hi"])
  expect(closedWith).toBe(4000)
  expect(heard).toEqual(["hi", "bye", "closed:4000"])
})
