/**
 * WebSocket sessions on a raw socket, and what each client received.
 *
 * A WebSocket client hides what the harness compares: it joins fragments, answers pings, refuses to
 * send a frame RFC 6455 forbids, and turns a close frame into an event that drops a bad code. So the
 * handshake and every frame go over `node:net` here, written and read as the RFC lays them out.
 */
import { connect, type Socket } from "node:net"
import { MAX_BODY_BYTES } from "../fixtures/runtime-differential/app.ts"
import { CONNECT_ATTEMPTS, parseResponse, RETRYABLE_CONNECT, withDeadline } from "./wire.ts"

export type WsRouteId = "echo" | "room" | "guarded"

export type WsStep =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary"; readonly size: number }
  /** One text message sent as a first frame and continuation frames. */
  | { readonly kind: "fragments"; readonly parts: readonly string[] }
  /** A text frame whose payload is not UTF-8. */
  | { readonly kind: "bad-utf8" }
  | { readonly kind: "ping"; readonly text: string }
  /** A close frame; no `code` sends one with no payload. */
  | { readonly kind: "close"; readonly code?: number; readonly reason: string }
  /** A text frame without the mask every client frame must carry. */
  | { readonly kind: "unmasked" }

export interface WsCase {
  readonly kind: "ws"
  readonly route: WsRouteId
  readonly path: string
  /** Sent with the handshake, after the ones every handshake carries. */
  readonly headers: readonly (readonly [string, string])[]
  /** What the first socket sends, in order. */
  readonly steps: readonly WsStep[]
  /** Sockets in the same room besides the sender. */
  readonly peers: number
}

/** One thing a socket saw, in order. */
export type WsEvent =
  /** The handshake was answered with a status other than 101. */
  | {
      readonly kind: "refused"
      readonly status: number
      readonly headers: readonly (readonly [string, string])[]
      readonly body: Uint8Array
    }
  | { readonly kind: "open"; readonly headers: readonly (readonly [string, string])[] }
  | { readonly kind: "text"; readonly bytes: Uint8Array }
  | { readonly kind: "binary"; readonly bytes: Uint8Array }
  | { readonly kind: "pong"; readonly bytes: Uint8Array }
  | { readonly kind: "close"; readonly bytes: Uint8Array }
  /** The connection ended before a close frame. */
  | { readonly kind: "end" }
  | { readonly kind: "timeout"; readonly waiting: string }
  | { readonly kind: "malformed"; readonly detail: string }
  /** The client sent a frame RFC 6455 forbids; what follows is the runtime failing the connection. */
  | { readonly kind: "violation"; readonly step: WsStep["kind"] }
  /** The client sent a message over the app's cap; what follows is the socket closing for it. */
  | { readonly kind: "oversize" }

export interface WsOutcome {
  readonly sockets: readonly (readonly WsEvent[])[]
}

const encoder = new TextEncoder()
// The sample nonce of RFC 6455 section 1.3: every runtime must answer it with the same accept key.
const KEY = "dGhlIHNhbXBsZSBub25jZQ=="
const MASK = Uint8Array.of(0x37, 0xfa, 0x21, 0x3d)

const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function frame(opcode: number, payload: Uint8Array, fin = true, masked = true): Uint8Array {
  const size = payload.length
  const lengthBytes = size < 126 ? 0 : size < 65_536 ? 2 : 8
  const head = new Uint8Array(2 + lengthBytes + (masked ? 4 : 0))
  head[0] = (fin ? 0x80 : 0) | opcode
  const maskBit = masked ? 0x80 : 0
  if (lengthBytes === 0) head[1] = maskBit | size
  else if (lengthBytes === 2) {
    head[1] = maskBit | 126
    new DataView(head.buffer).setUint16(2, size)
  } else {
    head[1] = maskBit | 127
    new DataView(head.buffer).setBigUint64(2, BigInt(size))
  }
  if (!masked) return concat(head, payload)
  head.set(MASK, 2 + lengthBytes)
  const body = new Uint8Array(size)
  for (let i = 0; i < size; i++) body[i] = (payload[i] ?? 0) ^ (MASK[i % 4] ?? 0)
  return concat(head, body)
}

/** RFC 6455 section 7.4: the codes a close frame may carry. */
const sendableCode = (code: number) =>
  (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)

/**
 * Whether RFC 6455 forbids the frame `step` sends: invalid UTF-8 in a text frame, a frame without a
 * mask, a control frame over 125 bytes, or a close code no endpoint may send. The server must fail
 * the connection, and each runtime does that its own way.
 */
export function violatesProtocol(step: WsStep): boolean {
  switch (step.kind) {
    case "bad-utf8":
    case "unmasked":
      return true
    case "ping":
      return encoder.encode(step.text).length > 125
    case "close":
      return step.code === undefined
        ? step.reason !== ""
        : !sendableCode(step.code) || encoder.encode(step.reason).length > 123
    default:
      return false
  }
}

/** The bytes of the message `step` sends, for a step that sends one. */
function messageBytes(step: WsStep): number {
  switch (step.kind) {
    case "text":
      return encoder.encode(step.text).length
    case "binary":
      return step.size
    case "fragments":
      return encoder.encode(step.parts.join("")).length
    default:
      return 0
  }
}

/** A binary payload whose bytes say where they are, so a reordered or truncated copy differs. */
export function patternedBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  return bytes
}

function closePayload(code: number | undefined, reason: string): Uint8Array {
  if (code === undefined) return new Uint8Array(0)
  const text = encoder.encode(reason)
  const out = new Uint8Array(2 + text.length)
  new DataView(out.buffer).setUint16(0, code)
  out.set(text, 2)
  return out
}

/** Events that are not the server's: the handshake, a deadline, and the client's own markers. */
const UNANSWERED: ReadonlySet<WsEvent["kind"]> = new Set([
  "open",
  "timeout",
  "violation",
  "oversize",
])

/** One client connection: the handshake, then every frame the server sent, as events. */
class Session {
  readonly events: WsEvent[] = []
  closeSent = false
  closeReceived = false
  ended = false
  private buffer: Uint8Array = new Uint8Array(0)
  private opened = false
  private message: { readonly opcode: number; parts: Uint8Array } | undefined
  private socket!: Socket

  /** `listeners` is shared by every socket of a case: one waits on what another sees. */
  private constructor(private readonly listeners: Set<() => void>) {}

  /** Connect and send the handshake. Resolves once the handshake is answered or the connection ends. */
  static open(
    port: number,
    path: string,
    headers: readonly (readonly [string, string])[],
    listeners: Set<() => void>,
  ): Promise<Session> {
    const session = new Session(listeners)
    const attempt = (count: number) => {
      const socket = connect({ port, host: "127.0.0.1" })
      session.socket = socket
      let connected = false
      socket.on("connect", () => {
        connected = true
        session.handshake(path, headers)
      })
      socket.on("data", (chunk: Uint8Array) => session.receive(chunk))
      socket.on("end", () => session.finish())
      socket.on("close", () => session.finish())
      socket.on("error", (error: NodeJS.ErrnoException) => {
        // As in `exchange`: before a connection exists nothing reached the server, so a refusal is
        // this machine's sockets, not the runtime.
        if (!connected && count < CONNECT_ATTEMPTS && RETRYABLE_CONNECT.has(error.code ?? "")) {
          socket.removeAllListeners()
          socket.destroy()
          attempt(count + 1)
          return
        }
        session.finish(error.code ?? error.message)
      })
    }
    attempt(1)
    return new Promise((resolve) => {
      const check = () => {
        if (session.events.length > 0 || session.ended) {
          session.listeners.delete(check)
          resolve(session)
        }
      }
      session.listeners.add(check)
    })
  }

  private handshake(path: string, headers: readonly (readonly [string, string])[]): void {
    const head = [
      `GET ${path} HTTP/1.1`,
      "Host: 127.0.0.1",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${KEY}`,
      "Sec-WebSocket-Version: 13",
      ...headers.map(([name, value]) => `${name}: ${value}`),
    ]
    this.socket.write(encoder.encode(`${head.join("\r\n")}\r\n\r\n`))
  }

  get isOpen(): boolean {
    return this.opened && !this.closeReceived && !this.ended
  }

  /** Events that answer something the client sent: a message, a pong, a close or the end. */
  get answers(): number {
    let count = 0
    for (const event of this.events) if (!UNANSWERED.has(event.kind)) count++
    return count
  }

  hasText(prefix: string): boolean {
    const wanted = encoder.encode(prefix)
    return this.events.some(
      (event) =>
        event.kind === "text" &&
        event.bytes.length >= wanted.length &&
        wanted.every((byte, i) => event.bytes[i] === byte),
    )
  }

  /** Until `ready` holds or the connection ends; a deadline first is recorded as a timeout. */
  async until(ready: () => boolean, waiting: string, deadlineAt: number): Promise<void> {
    if (ready() || this.ended) return
    const settled = new Promise<boolean>((resolve) => {
      const check = () => {
        if (ready() || this.ended) {
          this.listeners.delete(check)
          resolve(true)
        }
      }
      this.listeners.add(check)
    })
    const done = await withDeadline(settled, Math.max(deadlineAt - Date.now(), 0), () => false)
    if (!done) this.events.push({ kind: "timeout", waiting })
  }

  send(step: WsStep): void {
    if (this.ended) return
    if (violatesProtocol(step)) this.push({ kind: "violation", step: step.kind })
    else if (messageBytes(step) > MAX_BODY_BYTES) this.push({ kind: "oversize" })
    switch (step.kind) {
      case "text":
        this.socket.write(frame(OP.text, encoder.encode(step.text)))
        return
      case "binary":
        this.socket.write(frame(OP.binary, patternedBytes(step.size)))
        return
      case "fragments": {
        const parts = step.parts.length === 0 ? [""] : step.parts
        parts.forEach((part, i) => {
          this.socket.write(
            frame(
              i === 0 ? OP.text : OP.continuation,
              encoder.encode(part),
              i === parts.length - 1,
            ),
          )
        })
        return
      }
      case "bad-utf8":
        this.socket.write(frame(OP.text, Uint8Array.of(0x61, 0xc3, 0x28, 0x62)))
        return
      case "ping":
        this.socket.write(frame(OP.ping, encoder.encode(step.text)))
        return
      case "close":
        this.closeSent = true
        this.socket.write(frame(OP.close, closePayload(step.code, step.reason)))
        return
      case "unmasked":
        this.socket.write(frame(OP.text, encoder.encode("unmasked"), true, false))
        return
    }
  }

  /** Close as a client does: once, and with the code the server sent when it closed first. */
  close(): void {
    if (this.closeSent || this.ended) return
    const received = this.events.find((event) => event.kind === "close")
    const echoed = received?.kind === "close" ? received.bytes.subarray(0, 2) : undefined
    this.closeSent = true
    this.socket.write(
      frame(OP.close, echoed === undefined ? closePayload(1000, "done") : echoed.slice()),
    )
  }

  destroy(): void {
    this.socket.destroy()
  }

  private push(event: WsEvent): void {
    this.events.push(event)
    for (const listener of [...this.listeners]) listener()
  }

  private finish(cause?: string): void {
    if (this.ended) return
    this.ended = true
    if (!this.opened && this.buffer.length === 0) {
      this.push({ kind: "malformed", detail: `handshake: no answer${cause ? ` (${cause})` : ""}` })
      return
    }
    if (!this.opened) {
      const answered = parseResponse(this.buffer, "GET", true)
      if (answered.kind === "complete") this.push({ kind: "refused", ...answered.response })
      else this.push({ kind: "malformed", detail: `handshake: ${answered.kind}` })
      return
    }
    // The end after a close frame is how a close completes; only an end without one is an event.
    if (this.closeReceived) {
      for (const listener of [...this.listeners]) listener()
      return
    }
    this.push({ kind: "end" })
  }

  private receive(chunk: Uint8Array): void {
    this.buffer = concat(this.buffer, chunk)
    if (!this.opened) {
      const head = handshakeHead(this.buffer)
      if (head === undefined) return
      if (head.status !== 101) {
        const answered = parseResponse(this.buffer, "GET", false)
        if (answered.kind === "complete") {
          this.push({ kind: "refused", ...answered.response })
          this.ended = true
          this.socket.destroy()
        }
        return
      }
      this.opened = true
      this.buffer = this.buffer.subarray(head.end)
      this.push({ kind: "open", headers: head.headers })
    }
    this.frames()
  }

  private frames(): void {
    for (;;) {
      const bytes = this.buffer
      if (bytes.length < 2) return
      const first = bytes[0] ?? 0
      const second = bytes[1] ?? 0
      let size = second & 0x7f
      let at = 2
      if (size === 126) {
        if (bytes.length < 4) return
        size = new DataView(bytes.buffer, bytes.byteOffset).getUint16(2)
        at = 4
      } else if (size === 127) {
        if (bytes.length < 10) return
        size = Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(2))
        at = 10
      }
      if ((second & 0x80) !== 0) {
        this.push({ kind: "malformed", detail: "a server frame was masked" })
        this.ended = true
        this.socket.destroy()
        return
      }
      if (bytes.length < at + size) return
      const payload = bytes.slice(at, at + size)
      this.buffer = bytes.subarray(at + size)
      this.onFrame((first & 0x80) !== 0, first & 0x0f, payload)
    }
  }

  private onFrame(fin: boolean, opcode: number, payload: Uint8Array): void {
    if (opcode === OP.ping) {
      // A ping the server sends to keep the connection alive is transport: answered, not recorded.
      if (!this.closeSent) this.socket.write(frame(OP.pong, payload))
      return
    }
    if (opcode === OP.pong) {
      this.push({ kind: "pong", bytes: payload })
      return
    }
    if (opcode === OP.close) {
      this.closeReceived = true
      this.push({ kind: "close", bytes: payload })
      return
    }
    // A runtime may split a message into frames as it likes; the message is what the app sent.
    if (opcode === OP.continuation) {
      if (this.message === undefined) {
        this.push({ kind: "malformed", detail: "continuation without a message" })
        return
      }
      this.message.parts = concat(this.message.parts, payload)
    } else this.message = { opcode, parts: payload }
    if (!fin) return
    const { opcode: kind, parts } = this.message
    this.message = undefined
    if (kind === OP.text) this.push({ kind: "text", bytes: parts })
    else if (kind === OP.binary) this.push({ kind: "binary", bytes: parts })
    else this.push({ kind: "malformed", detail: `opcode ${kind}` })
  }
}

const latin1 = new TextDecoder("latin1")

function handshakeHead(bytes: Uint8Array):
  | {
      readonly status: number
      readonly headers: readonly (readonly [string, string])[]
      readonly end: number
    }
  | undefined {
  let split = -1
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      split = i
      break
    }
  }
  if (split === -1) return undefined
  const lines = latin1.decode(bytes.subarray(0, split)).split("\r\n")
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0)
  const headers = lines.slice(1).map((line): readonly [string, string] => {
    const colon = line.indexOf(":")
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]
  })
  return { status, headers, end: split + 4 }
}

/** The first text a socket expects once open, before the case's own frames. */
const GREETING: Readonly<Record<WsRouteId, string | undefined>> = {
  echo: undefined,
  room: "joined:",
  guarded: "hello:",
}

/**
 * Run one case against a server on `port`, every socket's events in order. `/ws/echo` runs beside a
 * `/ws/watch` socket, which hears what the server's `close` callback was given.
 */
export async function runWsCase(
  port: number,
  wsCase: WsCase,
  deadlineMs: number,
): Promise<WsOutcome> {
  const deadlineAt = Date.now() + deadlineMs
  const sessions: Session[] = []
  const listeners = new Set<() => void>()
  try {
    const watcher =
      wsCase.route === "echo" ? await Session.open(port, "/ws/watch", [], listeners) : undefined
    if (watcher !== undefined) {
      sessions.push(watcher)
      await watcher.until(() => watcher.hasText("joined"), "watch joined", deadlineAt)
    }
    const count = wsCase.route === "room" ? 1 + wsCase.peers : 1
    const sockets: Session[] = []
    for (let i = 0; i < count; i++) {
      const session = await Session.open(port, wsCase.path, wsCase.headers, listeners)
      sockets.push(session)
      sessions.push(session)
      const greeting = GREETING[wsCase.route]
      if (greeting !== undefined && session.isOpen)
        await session.until(() => session.hasText(greeting), `greeting ${greeting}`, deadlineAt)
    }
    const [sender] = sockets
    if (sender === undefined) throw new Error("[ws] no socket")
    if (sockets.every((session) => session.isOpen)) {
      for (const step of wsCase.steps) {
        const before = sockets.map((session) => session.answers)
        sender.send(step)
        if (step.kind === "close") break
        // The sender hears its own echo; in a room every socket hears the sender's message, unless
        // the server closed the sender instead.
        const listeners = wsCase.route === "room" ? sockets : [sender]
        await Promise.all(
          listeners.map((session, i) =>
            session.until(
              () => session.answers > (before[i] ?? 0) || !sender.isOpen,
              `an answer to ${step.kind}`,
              deadlineAt,
            ),
          ),
        )
        if (!sender.isOpen) break
      }
    }
    for (const session of sockets) {
      session.close()
      await session.until(() => session.closeReceived, "the close", deadlineAt)
      // The server waits for the client's close reply before its `close` callback runs.
      session.close()
    }
    if (watcher !== undefined && sender.events.some((event) => event.kind === "open")) {
      await watcher.until(() => watcher.hasText("closed:"), "the close report", deadlineAt)
    }
    if (watcher !== undefined) {
      watcher.close()
      await watcher.until(() => watcher.closeReceived, "the watcher's close", deadlineAt)
    }
    return {
      sockets: [...sockets, ...(watcher === undefined ? [] : [watcher])].map((s) => s.events),
    }
  } finally {
    for (const session of sessions) session.destroy()
  }
}
