/**
 * A Durable Object host for the live hub under Bun: storage with the platform's ordering and
 * structured-clone semantics, hibernatable sockets with attachments, and the runtime globals the hub
 * reaches for. "Hibernation" is a new hub object on the same state: memory gone, sockets and storage
 * kept.
 */
import type { LiveHubState, LiveHubStorage, LiveHubWebSocket } from "../src/live-hub.ts"

export class FakeStorage implements LiveHubStorage {
  readonly data = new Map<string, unknown>()
  alarm: number | null = null
  puts = 0

  async get(keys: string[]): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>()
    for (const key of keys)
      if (this.data.has(key)) out.set(key, structuredClone(this.data.get(key)))
    return out
  }

  async put(entries: Record<string, unknown>): Promise<void> {
    this.puts++
    for (const [key, value] of Object.entries(entries)) this.data.set(key, structuredClone(value))
  }

  async delete(keys: string[]): Promise<number> {
    let removed = 0
    for (const key of keys) if (this.data.delete(key)) removed++
    return removed
  }

  async list(options: {
    prefix: string
    end?: string
    limit?: number
  }): Promise<Map<string, unknown>> {
    const names = [...this.data.keys()]
      .filter(
        (key) => key.startsWith(options.prefix) && (options.end === undefined || key < options.end),
      )
      .sort()
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
    return new Map(names.map((name) => [name, structuredClone(this.data.get(name))]))
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime
  }
}

export class FakeSocket implements LiveHubWebSocket {
  readyState = 1
  readonly sent: string[] = []
  closed: { readonly code: number | undefined; readonly reason: string | undefined } | undefined
  private attachment: unknown = null
  /** The largest attachment serialized, in bytes of JSON. */
  largestAttachment = 0

  send(message: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error("socket closed")
    this.sent.push(typeof message === "string" ? message : "<binary>")
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) throw new Error("socket closed")
    this.readyState = 3
    this.closed = { code, reason }
  }

  serializeAttachment(value: unknown): void {
    this.largestAttachment = Math.max(
      this.largestAttachment,
      new TextEncoder().encode(JSON.stringify(value)).byteLength,
    )
    this.attachment = structuredClone(value)
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment)
  }

  /** Frames heard since the last call, parsed. */
  take(): unknown[] {
    return this.sent.splice(0).map((text) => (text === "p" ? text : JSON.parse(text)))
  }
}

export class FakeState implements LiveHubState {
  readonly storage = new FakeStorage()
  readonly accepted: FakeSocket[] = []
  readonly beats = new Map<LiveHubWebSocket, Date>()
  autoResponse: unknown

  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback()
  }

  acceptWebSocket(ws: LiveHubWebSocket): void {
    if (ws instanceof FakeSocket) this.accepted.push(ws)
  }

  getWebSockets(): LiveHubWebSocket[] {
    return this.accepted.filter((ws) => ws.readyState === 1)
  }

  setWebSocketAutoResponse(pair?: unknown): void {
    this.autoResponse = pair
  }

  getWebSocketAutoResponseTimestamp(ws: LiveHubWebSocket): Date | null {
    return this.beats.get(ws) ?? null
  }

  /** The socket accepted last. */
  get last(): FakeSocket {
    const socket = this.accepted.at(-1)
    if (socket === undefined) throw new Error("[fake] no socket was accepted")
    return socket
  }
}

class FakePair {
  readonly 0 = new FakeSocket()
  readonly 1 = new FakeSocket()
}

class FakeAutoResponse {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
}

/** Install the runtime globals the hub reaches for; returns the undo. */
export function installWorkerGlobals(): () => void {
  const globals = new Map<string, unknown>([
    ["WebSocketPair", FakePair],
    ["WebSocketRequestResponsePair", FakeAutoResponse],
  ])
  const before = new Map([...globals.keys()].map((name) => [name, Reflect.get(globalThis, name)]))
  for (const [name, value] of globals) Reflect.set(globalThis, name, value)
  return () => {
    for (const [name, value] of before) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name)
      else Reflect.set(globalThis, name, value)
    }
  }
}

export { FakeAutoResponse }
