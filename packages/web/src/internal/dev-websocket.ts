/**
 * The app's WebSocket routes under the dev servers. Neither dev server is the app's own listener, so
 * neither gets the upgrades `app.listen()` and the adapters wire: each hands the handshake to the
 * app's `resolveWebSocketUpgrade` seam - the route's `upgrade()` guard and Origin check included - and
 * wires an accepted socket with the runtime's own `attach`, so a dev socket behaves as a served one.
 */
import type { WebSocketUpgradeOutcome } from "@nifrajs/core"

type Upgrade = Extract<WebSocketUpgradeOutcome, { readonly kind: "upgrade" }>

/** A nifra app's handshake seam; a plain `{ fetch }` handler has none and takes no upgrades. */
export interface UpgradableApp {
  resolveWebSocketUpgrade?(
    request: Request,
  ): WebSocketUpgradeOutcome | Promise<WebSocketUpgradeOutcome>
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket"
}

type Listener = (event: never) => void

/** A standard-socket view `attach` wires its listeners to; the dev server feeds it events. */
function socketView(native: {
  send(data: string | ArrayBufferView | ArrayBuffer): unknown
  close(code?: number, reason?: string): void
  readonly readyState: number
}) {
  const listeners = new Map<string, Listener[]>()
  return {
    view: {
      send: (data: string | ArrayBufferView | ArrayBuffer): void => {
        native.send(data)
      },
      close: (code?: number, reason?: string) => native.close(code, reason),
      get readyState() {
        return native.readyState
      },
      addEventListener(type: string, listener: Listener): void {
        listeners.set(type, [...(listeners.get(type) ?? []), listener])
      },
    },
    emit(type: string, event: unknown): void {
      for (const listener of listeners.get(type) ?? []) Reflect.apply(listener, undefined, [event])
    },
  }
}

function attachView(view: ReturnType<typeof socketView>["view"], outcome: Upgrade): void {
  outcome.attach(view, outcome.handler, outcome.data, {
    openNow: true,
    pubsub: outcome.pubsub,
    maxPayloadBytes: outcome.maxPayloadBytes,
  })
}

// --- Bun ----------------------------------------------------------------------------------------

/** What a dev socket carries from its handshake to `open`, and the view its events go to after. */
export interface BunDevSocketData {
  readonly outcome: Upgrade
  emit?: (type: string, event: unknown) => void
}

/** The part of Bun's `ServerWebSocket` used here. */
interface BunDevSocket {
  send(data: string | ArrayBufferView | ArrayBuffer): unknown
  close(code?: number, reason?: string): void
  readonly readyState: number
  readonly data: BunDevSocketData
}

export interface BunUpgradeServer {
  upgrade(request: Request, options: { data: BunDevSocketData }): boolean
}

/** `Bun.serve`'s `websocket` option for a dev server whose upgrades go through {@link upgradeOnBun}. */
export const bunDevWebSocket = {
  open(socket: BunDevSocket): void {
    const { view, emit } = socketView(socket)
    socket.data.emit = emit
    attachView(view, socket.data.outcome)
  },
  message(socket: BunDevSocket, message: string | Uint8Array): void {
    socket.data.emit?.("message", { data: message })
  },
  close(socket: BunDevSocket, code: number, reason: string): void {
    socket.data.emit?.("close", { code, reason })
  },
}

/**
 * Run the handshake through the app. `undefined` when the socket was upgraded; a `Response` for a
 * refusal; `"pass"` when no WebSocket route takes the path, for the dev server to answer as HTTP.
 */
export async function upgradeOnBun(
  app: UpgradableApp,
  request: Request,
  server: BunUpgradeServer,
): Promise<Response | "pass" | undefined> {
  if (app.resolveWebSocketUpgrade === undefined) return "pass"
  const outcome = await app.resolveWebSocketUpgrade(request)
  if (outcome.kind === "pass") return "pass"
  if (outcome.kind === "reject") return outcome.response
  return server.upgrade(request, { data: { outcome } })
    ? undefined
    : new Response("upgrade_required", { status: 426 })
}

// --- Node (the Vite dev server) -------------------------------------------------------------------

/** The part of a Node socket an upgrade writes to. */
export interface UpgradeSocket {
  write(chunk: string): unknown
  destroy(): void
  on(event: "error", listener: () => void): unknown
}

/** The part of the `ws` package's `WebSocketServer` used here (no `@types/ws` dependency). */
export interface WsServer {
  handleUpgrade(
    request: unknown,
    socket: UpgradeSocket,
    head: unknown,
    done: (ws: WsSocket) => void,
  ): void
}

/** The part of a `ws` socket used here. Its own events, not its `addEventListener`: Bun's `ws`
 * shim hands text frames to that as bytes. The shim also gives a close reason as a string where
 * `ws` gives bytes. */
interface WsSocket {
  send(data: string | ArrayBufferView | ArrayBuffer): void
  close(code?: number, reason?: string): void
  readonly readyState: number
  on(event: "message", listener: (data: string | Uint8Array, isBinary: boolean) => void): void
  on(event: "close", listener: (code: number, reason: string | Uint8Array) => void): void
  on(event: "error", listener: (error: Error) => void): void
}

const TEXT = new TextDecoder()
const textOf = (data: string | Uint8Array): string =>
  typeof data === "string" ? data : TEXT.decode(data)

/** A non-literal specifier: `ws` is an optional peer, typed structurally above. */
const WS_MODULE = "ws"

/** A noServer `ws` server from `specifier`; undefined when it cannot be loaded or has none. */
export async function wsServerFrom(specifier: string): Promise<WsServer | undefined> {
  try {
    const mod: {
      WebSocketServer?: new (options: { noServer: true }) => WsServer
      default?: { WebSocketServer?: new (options: { noServer: true }) => WsServer }
    } = await import(specifier)
    const Server = mod.WebSocketServer ?? mod.default?.WebSocketServer
    return Server === undefined ? undefined : new Server({ noServer: true })
  } catch {
    return undefined
  }
}

let wsServer: Promise<WsServer | undefined> | undefined

/** One server for every dev upgrade. */
const loadWsServer = (): Promise<WsServer | undefined> => {
  wsServer ??= wsServerFrom(WS_MODULE)
  return wsServer
}

/**
 * Answer a Node `upgrade` event through the app. Resolves `false` when no WebSocket route takes the
 * path, leaving the socket to the other listeners (Vite's HMR among them).
 */
export async function upgradeOnNode(
  app: UpgradableApp,
  request: Request,
  nodeRequest: unknown,
  socket: UpgradeSocket,
  head: unknown,
  wsServerOf: () => Promise<WsServer | undefined> = loadWsServer,
): Promise<boolean> {
  if (app.resolveWebSocketUpgrade === undefined) return false
  // A peer can reset the socket while the guard is awaited; with no listener that error ends the process.
  socket.on("error", () => {})
  let outcome: WebSocketUpgradeOutcome
  try {
    outcome = await app.resolveWebSocketUpgrade(request)
  } catch {
    await writeRefusal(socket, new Response("internal_error", { status: 500 }))
    return true
  }
  if (outcome.kind === "pass") return false
  if (outcome.kind === "reject") {
    await writeRefusal(socket, outcome.response)
    return true
  }
  const wss = await wsServerOf()
  if (wss === undefined) {
    await writeRefusal(
      socket,
      new Response("[nifra] install `ws` to serve app.ws() routes under the Vite dev server\n", {
        status: 501,
      }),
    )
    return true
  }
  const upgrade = outcome
  wss.handleUpgrade(nodeRequest, socket, head, (ws) => {
    const { view, emit } = socketView(ws)
    ws.on("message", (data, isBinary) => emit("message", { data: isBinary ? data : textOf(data) }))
    // Bun's `node:http` stops listening when a socket's close listener throws.
    ws.on("close", (code, reason) => emit("close", { code, reason: textOf(reason) }))
    ws.on("error", (error) => emit("error", error))
    attachView(view, upgrade)
  })
  return true
}

/** A refusal written to the raw socket, then closed. */
async function writeRefusal(socket: UpgradeSocket, response: Response): Promise<void> {
  const body = await response.text()
  let head = `HTTP/1.1 ${response.status} ${response.statusText || "Refused"}\r\n`
  response.headers.forEach((value, key) => {
    if (key !== "content-length" && key !== "connection") head += `${key}: ${value}\r\n`
  })
  head += `content-length: ${new TextEncoder().encode(body).byteLength}\r\nconnection: close\r\n\r\n`
  socket.write(head + body)
  socket.destroy()
}
