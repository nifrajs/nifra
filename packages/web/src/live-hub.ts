/**
 * The live hub for Cloudflare Workers: one Durable Object per app owns the live log and holds every
 * live socket, hibernating between events. Request isolates run live loads themselves: each asks the
 * hub for the seq and the revocations its grants need, publishes through it, and forwards the socket
 * handshake to it.
 *
 * ```ts
 * import { liveHub } from "@nifrajs/web/live-hub"
 *
 * // A SQLite-backed Durable Object class, bound to the app's Worker as `LIVE_HUB`.
 * export const LiveHub = liveHub((env: Env) => ({ secret: env.LIVE_SECRET }))
 * // The app: live({ secret: env.LIVE_SECRET, subject, hub: env.LIVE_HUB })
 * ```
 *
 * What outlives the hub's memory: the seq, the revocation floor and every stored revocation, in
 * storage; each socket's membership (subject, expiry, tags) in storage under its sid; its sid, watch
 * gen and rate counters in its attachment. History does not: after a wake a watermark older than the
 * last seq before it is unknown and reads as stale. The runtime answers heartbeats without waking the
 * hub, and one alarm runs at the earliest deadline: a grant expiry, a first watch, a revocation's
 * retention.
 */
import type { NifraWebSocket, WebSocketData } from "@nifrajs/core/server"
import { type LiveBusInput, nextSeq } from "./live/bus.ts"
import { applyEvent, type LiveCore } from "./live/core.ts"
import { History, keyHasher } from "./live/history.ts"
import {
  CLOSE_CAPACITY,
  FIRST_WATCH_MS,
  type HubStore,
  LiveHub,
  type LiveSocket,
  type StoredSocket,
  topicOf,
} from "./live/hub.ts"
import {
  HUB_APPEND_PATH,
  HUB_AUTHORITY_PATH,
  HUB_CONFIG_HEADER,
  HUB_ORIGIN,
  hubConfigMatches,
  MAX_SUBJECT_CHARS,
  parseAppend,
  parseAuthorityRequest,
} from "./live/hub-protocol.ts"
import {
  assertLiveSecrets,
  createKeyring,
  KEY_PATTERN,
  type LiveSecrets,
  SID_PATTERN,
} from "./live/keyring.ts"
import { readCapped } from "./live/read-capped.ts"
import { REVOCATION_SKEW_MS, Revocations } from "./live/revocations.ts"
import {
  appIdOf,
  DEFAULT_RELOAD_RATE,
  grantTtlOf,
  positive,
  spreadFloorOf,
} from "./live/settings.ts"

export interface LiveHubOptions {
  /** The app's `live()` secret, or its rotation list. */
  readonly secret: string | readonly string[]
  /** The app's `live()` `appId`. Default `"nifra"`. */
  readonly appId?: string | undefined
  /** The app's `live()` `grantTtl`, at most 3600. Default 600. */
  readonly grantTtl?: number | undefined
  /** Origins besides the app's own that may open the socket. */
  readonly trustedOrigins?: readonly string[] | undefined
  /** Sockets this hub holds; past it a socket is closed with 1013. Default {@link DEFAULT_HUB_SOCKETS}. */
  readonly maxSockets?: number | undefined
  /**
   * Socket-tag subscriptions this hub holds in all; past it a watch is refused with 1013. The default,
   * {@link DEFAULT_HUB_MEMBERSHIPS}, keeps the hub's heap well inside a Durable Object's memory.
   */
  readonly maxMemberships?: number | undefined
  /** Live loads per second the deployment absorbs after one change, for spreading reloads. Default 500. */
  readonly reloadRate?: number | undefined
  /** The least time, in ms, clients spread their reloads over. Default 0. */
  readonly spreadFloor?: number | undefined
}

/** The part of a Durable Object's state the hub uses (no Cloudflare types dependency). */
export interface LiveHubState {
  readonly storage: LiveHubStorage
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
  acceptWebSocket(ws: LiveHubWebSocket): void
  getWebSockets(): LiveHubWebSocket[]
  setWebSocketAutoResponse(pair?: unknown): void
  getWebSocketAutoResponseTimestamp(ws: LiveHubWebSocket): Date | null
}

export interface LiveHubStorage {
  get(keys: string[]): Promise<Map<string, unknown>>
  put(entries: Record<string, unknown>): Promise<void>
  delete(keys: string[]): Promise<number>
  list(options: { prefix: string; end?: string; limit?: number }): Promise<Map<string, unknown>>
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number): Promise<void>
}

/** A hibernatable server socket, as far as the hub uses one. */
export interface LiveHubWebSocket {
  send(message: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
  readonly readyState: number
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

/** Per-socket limits the platform sets; the hub stays well under both (see the tests). */
export const MAX_ATTACHMENT_BYTES = 512
export const MAX_SOCKET_RECORD_BYTES = 30_720
/** The most sockets one hub was verified to hold, with every publish reaching them all well under 200 ms. */
export const DEFAULT_HUB_SOCKETS = 5_000
/**
 * About 440 bytes of heap each when no two sockets share a tag, the worst case; far less when they do.
 * 150,000 of them stay near 66 MB, inside the 128 MB a Durable Object's isolate may use.
 */
export const DEFAULT_HUB_MEMBERSHIPS = 150_000
/** Alarms come no closer together than this: expiry is checked again before every frame anyway. */
export const ALARM_GAP_MS = 30_000

const SEQ_KEY = "seq"
const APPLIED_KEY = "applied"
const FLOOR_KEY = "floor"
const REVOKED = "r:"
const SOCKET = "s:"
const DELETE_BATCH = 128
const MAX_CALL_BYTES = 65_536
const HEARTBEAT = "p"

interface Settings {
  readonly secrets: LiveSecrets
  readonly appId: string
  readonly ttl: number
  readonly trusted: ReadonlySet<string>
  readonly maxSockets: number
  readonly maxMemberships: number
  readonly reloadRate: number
  readonly spreadFloor: number
}

/**
 * The live hub's Durable Object class. Export it from the Worker's main module under the class name
 * the binding names.
 */
export function liveHub<Env = Record<string, string | undefined>>(
  options: LiveHubOptions | ((env: Env) => LiveHubOptions),
): new (
  state: LiveHubState,
  env: Env,
) => LiveHubObject {
  return class extends LiveHubObject {
    constructor(state: LiveHubState, env: Env) {
      super(state, typeof options === "function" ? options(env) : options)
    }
  }
}

export class LiveHubObject implements HubStore {
  private readonly ready: Promise<LiveCore>
  private readonly settings: Settings
  private readonly sockets = new WeakMap<LiveHubWebSocket, HubSocket>()
  private readonly topics = new Map<string, Set<HubSocket>>()
  private readonly hash = keyHasher()
  private core: LiveCore | undefined
  /** The last seq handed out, stored before its event is applied. */
  private seq = 0
  /** The last seq applied: a load's watermark. */
  private applied = 0
  /** The stored revocation floor. */
  private floor = 0
  /** Appends run one at a time, so history is recorded in seq order. */
  private chain: Promise<unknown> = Promise.resolve()
  private alarmAt: number | undefined
  private mismatchLogged = false

  constructor(
    private readonly state: LiveHubState,
    options: LiveHubOptions,
  ) {
    this.settings = settingsOf(options)
    this.ready = state.blockConcurrencyWhile(() => this.wake())
  }

  async fetch(req: Request): Promise<Response> {
    const core = await this.ready
    if (req.method === "GET" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.accept(core, req)
    }
    const url = new URL(req.url)
    const call = url.pathname
    if (
      req.method !== "POST" ||
      url.origin !== HUB_ORIGIN ||
      (call !== HUB_APPEND_PATH && call !== HUB_AUTHORITY_PATH)
    ) {
      return Response.json({ error: "not_found" }, { status: 404 })
    }
    if (!hubConfigMatches(core.ring, req.headers.get(HUB_CONFIG_HEADER))) {
      if (!this.mismatchLogged) {
        this.mismatchLogged = true
        console.error(
          "[nifra/web] live hub: an app called with a different `secret`, `appId` or `grantTtl` than this hub's; every call it makes is refused",
        )
      }
      return Response.json({ error: "config_mismatch" }, { status: 409 })
    }
    const body = await bodyOf(req)
    if (call === HUB_APPEND_PATH) {
      const input = parseAppend(body)
      if (input === undefined) return Response.json({ error: "bad_request" }, { status: 400 })
      return Response.json({ seq: await this.append(core, input) })
    }
    const ask = parseAuthorityRequest(body)
    if (ask === undefined) return Response.json({ error: "bad_request" }, { status: 400 })
    return Response.json({
      seq: this.applied,
      ...core.revocations.snapshot(ask.subjects, ask.keys),
    })
  }

  async webSocketMessage(raw: LiveHubWebSocket, message: string | ArrayBuffer): Promise<void> {
    const core = await this.ready
    const socket = this.sockets.get(raw)
    if (socket === undefined) return
    const data: WebSocketData = typeof message === "string" ? message : new Uint8Array(message)
    const installing = core.hub.message(socket, data)
    saveAttachment(socket)
    if (installing === undefined) return
    await installing
    // The watch moved its expiry and whether it holds a tag.
    saveAttachment(socket)
    await this.schedule(
      Math.min(
        socket.data.exp,
        (socket.data.unwatchedSince ?? Number.POSITIVE_INFINITY) + FIRST_WATCH_MS,
      ),
    )
  }

  async webSocketClose(raw: LiveHubWebSocket): Promise<void> {
    await this.left(raw)
    // Complete the closing handshake; a runtime that already replied throws here.
    closeQuietly(raw, 1000, "")
  }

  async webSocketError(raw: LiveHubWebSocket): Promise<void> {
    await this.left(raw)
  }

  async alarm(): Promise<void> {
    const core = await this.ready
    this.alarmAt = undefined
    const sockets = core.hub.sweep()
    const retention = await this.pruneRevocations(Date.now())
    await this.schedule(Math.min(sockets, retention))
  }

  // --- HubStore: what the shared hub tells this host to keep --------------------------------------

  saved(ws: NifraWebSocket<LiveSocket>, socket: StoredSocket): void {
    void this.state.storage.put({ [SOCKET + ws.data.sid]: socket }).catch(storageFailed)
  }

  removed(ws: NifraWebSocket<LiveSocket>): void {
    void this.state.storage.delete([SOCKET + ws.data.sid]).catch(storageFailed)
  }

  lastBeat(ws: NifraWebSocket<LiveSocket>): number {
    if (!(ws instanceof HubSocket)) return 0
    return this.state.getWebSocketAutoResponseTimestamp(ws.raw)?.getTime() ?? 0
  }

  // --- internals ----------------------------------------------------------------------------------

  /** Everything the hub knows comes back from storage and the runtime's sockets; history does not. */
  private async wake(): Promise<LiveCore> {
    const { state, settings } = this
    const storage = state.storage
    const ring = await createKeyring({
      secrets: settings.secrets,
      appId: settings.appId,
      ttl: settings.ttl,
    })
    const head = await storage.get([SEQ_KEY, APPLIED_KEY, FLOOR_KEY])
    const seq = head.get(SEQ_KEY)
    if (seqLike(seq)) {
      this.seq = seq
      const floor = head.get(FLOOR_KEY)
      this.floor = seqLike(floor) ? floor : seq
    } else {
      // A new hub, or one whose storage is gone: no grant issued before now is honored.
      this.seq = nextSeq(0, Date.now())
      this.floor = this.seq
      await storage.put({ [SEQ_KEY]: this.seq, [APPLIED_KEY]: this.seq, [FLOOR_KEY]: this.floor })
    }
    // An event stored but never applied may never have reached the sockets that watch it.
    const lost = head.get(APPLIED_KEY) !== this.seq && seqLike(seq)
    this.applied = this.seq

    const revocations = new Revocations(this.floor, settings.ttl * 1000)
    for (const [name, value] of await storage.list({ prefix: REVOKED })) {
      const entry = revocationOf(name, value)
      if (entry !== undefined && entry.seq >= this.floor) {
        revocations.apply(
          { type: "revoke", sub: entry.sub, key: entry.key, seq: entry.seq },
          entry.at,
        )
      }
    }
    const history = new History(this.seq)
    const hub = new LiveHub(
      ring,
      history,
      revocations,
      {
        appId: settings.appId,
        trusted: settings.trusted,
        maxSockets: settings.maxSockets,
        maxMemberships: settings.maxMemberships,
        maxRssBytes: undefined,
        reloadRate: settings.reloadRate,
        instances: 1,
        spreadFloor: settings.spreadFloor,
        hash: this.hash,
        store: this,
      },
      new Set([(topic: string, frame: string) => this.deliver(topic, frame)]),
    )
    const core: LiveCore = { ring, history, revocations, hub }
    this.core = core

    const records = await storage.list({ prefix: SOCKET })
    const kept = new Set<string>()
    let resynced = 0
    // Each record is its own copy of every tag string: one copy per tag serves every socket.
    const interned = new Map<string, string>()
    for (const raw of state.getWebSockets()) {
      const data = socketStateOf(raw.deserializeAttachment())
      const stored =
        data === undefined ? undefined : storedOf(records.get(SOCKET + data.sid), interned)
      // A socket that watched but lost its membership would miss every change: it reconnects.
      if (lost || data === undefined || (data.received >= 0 && stored === undefined)) {
        closeQuietly(raw, CLOSE_CAPACITY, "resync")
        resynced++
        continue
      }
      const socket = new HubSocket(raw, data, this.topics)
      this.sockets.set(raw, socket)
      hub.restore(socket, stored)
      kept.add(SOCKET + data.sid)
    }
    const orphans = [...records.keys()].filter((name) => !kept.has(name))
    for (let at = 0; at < orphans.length; at += DELETE_BATCH) {
      await storage.delete(orphans.slice(at, at + DELETE_BATCH))
    }
    if (lost) await storage.put({ [APPLIED_KEY]: this.seq })
    hub.burst(resynced)

    const Pair: unknown = Reflect.get(globalThis, "WebSocketRequestResponsePair")
    if (typeof Pair === "function") {
      state.setWebSocketAutoResponse(Reflect.construct(Pair, [HEARTBEAT, HEARTBEAT]))
    }
    this.alarmAt = (await storage.getAlarm()) ?? undefined
    return core
  }

  private async accept(core: LiveCore, req: Request): Promise<Response> {
    const data = core.hub.upgrade(req)
    if (data instanceof Response) return data
    const pair = socketPair()
    if (pair === undefined) return Response.json({ error: "unavailable" }, { status: 503 })
    const [client, server] = pair
    this.state.acceptWebSocket(server)
    const socket = new HubSocket(server, data, this.topics)
    this.sockets.set(server, socket)
    saveAttachment(socket)
    core.hub.open(socket)
    await this.schedule(Date.now() + FIRST_WATCH_MS)
    const init = { status: 101, webSocket: client }
    return new Response(null, init)
  }

  private append(core: LiveCore, input: LiveBusInput): Promise<number> {
    const run = this.chain.then(() => this.applyNext(core, input))
    this.chain = run.catch(() => {})
    return run
  }

  private async applyNext(core: LiveCore, input: LiveBusInput): Promise<number> {
    const storage = this.state.storage
    const now = Date.now()
    const seq = nextSeq(this.seq, now)
    this.seq = seq
    const kept = input.type === "revoke" && (input.sub !== null || input.key !== null)
    const writes: Record<string, unknown> = { [SEQ_KEY]: seq }
    if (kept) writes[revokedKey(seq)] = { sub: input.sub, key: input.key, at: now }
    // Stored before any socket hears of it: a revocation is never applied and then forgotten.
    await storage.put(writes)
    try {
      await applyEvent(core, { ...input, seq }, this.hash)
    } catch (err) {
      console.error(
        "[nifra/web] live hub: an event could not be applied; closing live sockets",
        err,
      )
      core.history.reset(seq)
      core.revocations.raise(seq)
      core.hub.closeAll(CLOSE_CAPACITY, "resync")
    }
    this.applied = seq
    const after: Record<string, unknown> = { [APPLIED_KEY]: seq }
    const raised = core.revocations.floor > this.floor
    if (raised) {
      this.floor = core.revocations.floor
      after[FLOOR_KEY] = this.floor
    }
    await storage.put(after)
    if (kept) await this.schedule(now + this.settings.ttl * 1000 + REVOCATION_SKEW_MS)
    else if (raised) await this.schedule(now)
    return seq
  }

  /** One frame to every socket on the topic whose grants are still valid. */
  private deliver(topic: string, frame: string): void {
    const members = this.topics.get(topic)
    const hub = this.core?.hub
    if (members === undefined || hub === undefined) return
    const now = Date.now()
    for (const socket of members) if (!hub.expired(socket, now)) socket.send(frame)
  }

  private async left(raw: LiveHubWebSocket): Promise<void> {
    const core = await this.ready
    const socket = this.sockets.get(raw)
    if (socket === undefined) return
    this.sockets.delete(raw)
    // The hub leaves a closed socket's topics without unsubscribing it; this registry is the host's.
    for (const tag of socket.data.tags) socket.unsubscribe(topicOf(this.settings.appId, tag))
    core.hub.close(socket)
  }

  /** Drop revocations every grant they could refuse has outlived. Returns the next one's deadline. */
  private async pruneRevocations(now: number): Promise<number> {
    const storage = this.state.storage
    const ttlMs = this.settings.ttl * 1000
    const horizon = (now - ttlMs - REVOCATION_SKEW_MS) * 1000
    const end = revokedKey(Math.max(this.floor, Math.floor(horizon)))
    for (;;) {
      const stale = [...(await storage.list({ prefix: REVOKED, end, limit: DELETE_BATCH })).keys()]
      if (stale.length === 0) break
      await storage.delete(stale)
    }
    for (const [name, value] of await storage.list({ prefix: REVOKED, limit: 1 })) {
      const entry = revocationOf(name, value)
      if (entry !== undefined) return entry.at + ttlMs + REVOCATION_SKEW_MS
    }
    return Number.POSITIVE_INFINITY
  }

  private async schedule(deadline: number): Promise<void> {
    if (!Number.isFinite(deadline)) return
    const at = Math.max(deadline, Date.now() + ALARM_GAP_MS)
    if (this.alarmAt !== undefined && this.alarmAt <= at) return
    this.alarmAt = at
    await this.state.storage.setAlarm(at)
  }
}

/** A hibernatable socket under the hub's own topic registry. */
class HubSocket implements NifraWebSocket<LiveSocket> {
  constructor(
    readonly raw: LiveHubWebSocket,
    public data: LiveSocket,
    private readonly topics: Map<string, Set<HubSocket>>,
  ) {}

  get readyState(): number {
    return this.raw.readyState
  }

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    try {
      this.raw.send(data)
    } catch {
      // Closed meanwhile: its close event settles the rest.
    }
  }

  close(code?: number, reason?: string): void {
    closeQuietly(this.raw, code, reason)
  }

  subscribe(topic: string): void {
    let members = this.topics.get(topic)
    if (members === undefined) {
      members = new Set()
      this.topics.set(topic, members)
    }
    members.add(this)
  }

  unsubscribe(topic: string): void {
    const members = this.topics.get(topic)
    if (members === undefined || !members.delete(this)) return
    if (members.size === 0) this.topics.delete(topic)
  }
}

function settingsOf(options: LiveHubOptions): Settings {
  const secret = options.secret
  const secrets: readonly unknown[] = typeof secret === "string" ? [secret] : (secret ?? [])
  assertLiveSecrets(secrets)
  return {
    secrets,
    appId: appIdOf(options.appId),
    ttl: grantTtlOf(options.grantTtl),
    trusted: new Set(options.trustedOrigins ?? []),
    maxSockets: positive(options.maxSockets, DEFAULT_HUB_SOCKETS, "maxSockets"),
    maxMemberships: positive(options.maxMemberships, DEFAULT_HUB_MEMBERSHIPS, "maxMemberships"),
    reloadRate: positive(options.reloadRate, DEFAULT_RELOAD_RATE, "reloadRate"),
    spreadFloor: spreadFloorOf(options.spreadFloor),
  }
}

/**
 * Sid, gen, rate counters and since when it held no tag (-1 while it holds one): what a socket needs
 * back after a wake that its record does not hold.
 */
function saveAttachment(socket: HubSocket): void {
  const s = socket.data
  try {
    socket.raw.serializeAttachment([
      s.sid,
      s.received,
      s.window,
      s.frames,
      s.watches,
      s.lastSeen,
      s.unwatchedSince ?? -1,
    ])
  } catch {
    // Closed meanwhile: nothing comes back for it.
  }
}

function socketStateOf(value: unknown): LiveSocket | undefined {
  if (!Array.isArray(value) || value.length !== 7) return undefined
  const [sid, received, window, frames, watches, lastSeen, unwatchedSince] = value
  if (typeof sid !== "string" || !SID_PATTERN.test(sid)) return undefined
  if (!integer(received) || received < -1) return undefined
  if (!integer(unwatchedSince) || unwatchedSince < -1) return undefined
  if (!seqLike(window) || !seqLike(frames) || !seqLike(watches) || !seqLike(lastSeen)) {
    return undefined
  }
  return {
    sid,
    sub: undefined,
    received,
    tags: new Set(),
    exp: Number.POSITIVE_INFINITY,
    unwatchedSince: unwatchedSince === -1 ? undefined : unwatchedSince,
    window,
    frames,
    watches,
    lastSeen,
  }
}

function storedOf(value: unknown, interned: Map<string, string>): StoredSocket | undefined {
  if (!isRecord(value)) return undefined
  const { sub, exp, tags } = value
  if (sub !== null && !subjectLike(sub)) return undefined
  if (typeof exp !== "number" || Number.isNaN(exp) || !Array.isArray(tags)) return undefined
  const list: string[] = []
  for (const tag of tags) {
    if (typeof tag !== "string") return undefined
    const known = interned.get(tag)
    if (known === undefined) interned.set(tag, tag)
    list.push(known ?? tag)
  }
  return { sub, exp, tags: list }
}

interface StoredRevocation {
  readonly seq: number
  readonly sub: string | null
  readonly key: string | null
  readonly at: number
}

function revocationOf(name: string, value: unknown): StoredRevocation | undefined {
  const seq = Number(name.slice(REVOKED.length))
  if (!seqLike(seq) || !isRecord(value)) return undefined
  const { sub, key, at } = value
  if (sub !== null && !subjectLike(sub)) return undefined
  if (key !== null && (typeof key !== "string" || !KEY_PATTERN.test(key))) return undefined
  if (!seqLike(at)) return undefined
  return { seq, sub, key, at }
}

/** Fixed width, so storage order is seq order. */
const revokedKey = (seq: number): string => REVOKED + String(seq).padStart(16, "0")

function socketPair(): [unknown, LiveHubWebSocket] | undefined {
  const Pair: unknown = Reflect.get(globalThis, "WebSocketPair")
  if (typeof Pair !== "function") return undefined
  const pair: unknown = Reflect.construct(Pair, [])
  if (!isRecord(pair)) return undefined
  const server = pair[1]
  return isHubWebSocket(server) ? [pair[0], server] : undefined
}

function isHubWebSocket(value: unknown): value is LiveHubWebSocket {
  return (
    isRecord(value) &&
    typeof value.send === "function" &&
    typeof value.close === "function" &&
    typeof value.serializeAttachment === "function" &&
    typeof value.deserializeAttachment === "function"
  )
}

function closeQuietly(raw: LiveHubWebSocket, code?: number, reason?: string): void {
  try {
    raw.close(code, reason)
  } catch {
    // Already closed.
  }
}

async function bodyOf(req: Request): Promise<unknown> {
  const text = await readCapped(req, MAX_CALL_BYTES)
  if (typeof text === "number") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function storageFailed(err: unknown): void {
  console.error("[nifra/web] live hub: a storage write failed", err)
}

const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value)

const seqLike = (value: unknown): value is number => integer(value) && value >= 0

const subjectLike = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_SUBJECT_CHARS

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
