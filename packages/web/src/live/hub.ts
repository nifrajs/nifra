/**
 * The live socket endpoint and its fan-out. A socket subscribes to the tags of the keys its installed
 * grants hold; each change goes out as one identical `changed` frame per tag topic, so Bun can send it
 * with one native publish. Frames carry tags only: never data, key text, subjects or seqs.
 *
 * Installing a watch and applying a bus event each run as one synchronous step (subscribe, then scan
 * history, then `ready`; record in history, then publish), so every event is either reported in
 * `ready.stale` or delivered after the subscription, and `ready` precedes every later frame.
 */
import { isSameOriginRequest, type NifraWebSocket, type WebSocketData } from "@nifrajs/core/server"
import { isRecord } from "../internal/record.ts"
import type { LiveRevocation } from "./bus.ts"
import type { History } from "./history.ts"
import { type Keyring, MAX_GRANT_CHARS, type OpenedGrant } from "./keyring.ts"
import type { Revocations } from "./revocations.ts"

export const CLOSE_BAD_GRANT = 4401
export const CLOSE_REVOKED = 4403
export const CLOSE_SCOPE = 4409
export const CLOSE_CAPACITY = 1013
export const CLOSE_PROTOCOL = 1008
/** The runtime closed: reconnect, most likely to another process. */
export const CLOSE_GOING_AWAY = 1001
/** Nothing to watch: a tab with no tag to hear about reconnects only once it has one. */
export const CLOSE_UNWATCHED = 1000

export const MAX_FRAME_BYTES = 32_768
export const MAX_WATCH_GRANTS = 3
export const MAX_WATCHES_PER_MINUTE = 20
/** Every inbound frame, heartbeats included: a client heartbeats twice a minute. */
export const MAX_FRAMES_PER_MINUTE = 60
export const MAX_OUTBOUND_BYTES = 65_536
export const MAX_TOPICS = 200_000
export const IDLE_MS = 150_000
/**
 * How long a socket may hold no tag: from its open, or from the watch or revocation that left it
 * none. A tab watches right after its first live load, so only a socket nobody listens on runs out.
 */
export const FIRST_WATCH_MS = 60_000
export const SWEEP_MS = 10_000
export const COALESCE_MS = 25
/** How long after closing many sockets at once their reconnects are told to spread their reloads. */
export const RECONNECT_WINDOW_MS = 30_000
const TAG_CACHE_SIZE = 16_384
const SPREAD_STEPS = [250, 500, 1000, 2000, 5000]
const HEARTBEAT = "p"

export interface HubOptions {
  readonly appId: string
  readonly trusted: ReadonlySet<string>
  readonly maxSockets: number
  readonly maxRssBytes: number | undefined
  readonly reloadRate: number
  readonly instances: number
  readonly spreadFloor: number
  readonly hash: (key: string) => number
  /** Distinct tags this process holds subscriptions for. Default {@link MAX_TOPICS}. */
  readonly maxTopics?: number
  /** Where key tags come from; the runtime shares one cache between its loads and this hub. */
  readonly tags?: TagOf
  /**
   * Socket-tag subscriptions this process holds in all; past it a watch is refused with 1013. For a
   * host whose memory is capped below what its sockets could ask for. Default: no budget.
   */
  readonly maxMemberships?: number
  /**
   * Where a hub that outlives its memory keeps socket state (a hibernating Durable Object): told of
   * every installed watch and every socket that leaves. Its sweep runs on the host's alarm instead
   * of a timer, which would keep the host awake.
   */
  readonly store?: HubStore
}

/** What a socket's membership is, kept so a hub can {@link LiveHub.restore} it after its memory is gone. */
export interface StoredSocket {
  readonly sub: string | null
  readonly exp: number
  readonly tags: readonly string[]
}

export interface HubStore {
  saved(ws: NifraWebSocket<LiveSocket>, socket: StoredSocket): void
  removed(ws: NifraWebSocket<LiveSocket>): void
  /** The last time the host answered this socket's heartbeat without waking the hub. */
  lastBeat(ws: NifraWebSocket<LiveSocket>): number
}

/** Per-connection state, held in `ws.data`. */
export interface LiveSocket {
  sid: string
  /** The subject of the first accepted grant; `undefined` until then. */
  sub: string | null | undefined
  /** The highest `gen` received; a lower or equal one is ignored. */
  received: number
  tags: Set<string>
  /** Earliest installed grant expiry, ms. */
  exp: number
  /** Since when it has held no tag; `undefined` while it holds one. See {@link FIRST_WATCH_MS}. */
  unwatchedSince: number | undefined
  window: number
  frames: number
  watches: number
  lastSeen: number
}

interface Watch {
  readonly gen: number
  readonly grants: readonly string[]
}

interface Prepared {
  readonly grant: OpenedGrant
  readonly owners: readonly { readonly id: string; readonly w: number; readonly hashes: number[] }[]
  readonly tags: readonly string[]
}

interface Pending {
  tags: readonly string[]
  again: boolean
}

export class LiveHub {
  /** Bus unreachable: no watch is accepted and no socket kept. */
  down = false
  /** `changed` frames sent, one per subscribed socket: each makes a page reload. */
  notified = 0
  private readonly sockets = new Set<NifraWebSocket<LiveSocket>>()
  /** Local subscribers per tag: the intern table, and the input to `spread`. */
  private readonly members = new Map<string, number>()
  /** Socket-tag subscriptions held, the sum of `members`. */
  private memberships = 0
  private readonly tagOf: TagOf
  private readonly coalescing = new Map<string, Pending>()
  /** The last time many sockets were closed at once, and how many. */
  private burstAt = Number.NEGATIVE_INFINITY
  private burstSize = 0
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly ring: Keyring,
    private readonly history: History,
    private readonly revocations: Revocations,
    private readonly options: HubOptions,
    /** Where `changed` frames go: each attached app's `publish`. */
    private readonly publishers: ReadonlySet<(topic: string, frame: string) => void>,
  ) {
    this.tagOf = options.tags ?? tagCache(ring)
  }

  get size(): number {
    return this.sockets.size
  }

  /** The tag of `key` under each listed secret, newest first. */
  tagsOf(key: string): Promise<string[]> {
    const tags: Promise<string>[] = []
    for (let secret = 0; secret < this.ring.secretCount; secret++)
      tags.push(this.tagOf(key, secret))
    return Promise.all(tags)
  }

  /** The handshake: a missing, `null` or untrusted Origin is refused. */
  upgrade(req: Request): LiveSocket | Response {
    const origin = req.headers.get("origin")
    if (
      origin === null ||
      !(this.options.trusted.has(origin) || isSameOriginRequest(origin, req))
    ) {
      return Response.json({ error: "forbidden_origin" }, { status: 403 })
    }
    const now = Date.now()
    return {
      sid: randomSid(),
      sub: undefined,
      received: -1,
      tags: new Set<string>(),
      exp: Number.POSITIVE_INFINITY,
      unwatchedSince: now,
      window: now,
      frames: 0,
      watches: 0,
      lastSeen: now,
    }
  }

  open(ws: NifraWebSocket<LiveSocket>): void {
    if (this.down || this.sockets.size >= this.options.maxSockets || this.overRss()) {
      ws.close(CLOSE_CAPACITY, "at capacity")
      return
    }
    this.sockets.add(ws)
    this.startSweep()
    const spread = Date.now() - this.burstAt < RECONNECT_WINDOW_MS ? this.spread(this.burstSize) : 0
    this.send(
      ws,
      JSON.stringify(
        spread > 0
          ? { t: "welcome", sid: ws.data.sid, spread }
          : { t: "welcome", sid: ws.data.sid },
      ),
    )
  }

  /** The runtime has dropped the closed socket's topics; only the counts are left to settle. */
  close(ws: NifraWebSocket<LiveSocket>): void {
    this.forget(ws, false)
  }

  /** A change, already in history: publish one frame per tag, at most once per key per window. */
  change(keys: readonly string[], tags: readonly (readonly string[])[]): void {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] ?? ""
      const keyTags = tags[i] ?? []
      // Nobody here watches it: nothing to send now or at the end of a window.
      if (!keyTags.some((tag) => this.members.has(tag))) continue
      const pending = this.coalescing.get(key)
      if (pending !== undefined) {
        pending.again = true
        continue
      }
      this.coalescing.set(key, { tags: keyTags, again: false })
      this.publishTags(keyTags)
    }
    if (this.coalescing.size > 0 && this.coalesceTimer === undefined) {
      this.coalesceTimer = unref(setTimeout(() => this.flush(), COALESCE_MS))
    }
  }

  /** A revocation, already stored. `tags` are the key's tags for a `revokeKey`. */
  revoke(event: LiveRevocation, tags: readonly string[]): void {
    if (event.key === null) {
      for (const ws of [...this.sockets]) {
        if (event.sub === null || ws.data.sub === event.sub) this.drop(ws, CLOSE_REVOKED, "revoked")
      }
      return
    }
    // One terminal `changed` to every subscriber, then the revoked ones leave the topics: no later
    // frame for this key reaches them.
    this.publishTags(tags)
    for (const ws of this.sockets) {
      if (event.sub !== null && ws.data.sub !== event.sub) continue
      let left = false
      for (const tag of tags) {
        if (!ws.data.tags.has(tag)) continue
        this.leave(ws, tag)
        left = true
      }
      const state = ws.data
      if (left && state.tags.size === 0) state.unwatchedSince ??= Date.now()
      if (left)
        this.options.store?.saved(ws, {
          sub: state.sub ?? null,
          exp: state.exp,
          tags: [...state.tags],
        })
    }
  }

  /** Close every socket: history or revocations before now are unknown, or the bus is gone. */
  closeAll(code: number, reason: string): void {
    const sockets = [...this.sockets]
    this.burst(sockets.length)
    for (const ws of sockets) this.drop(ws, code, reason)
  }

  /**
   * `count` sockets just closed together and will reconnect together. Each must reload under its new
   * socket id, so for a while `welcome` tells them to spread those reloads as a change would.
   */
  burst(count: number): void {
    const now = Date.now()
    const recent = now - this.burstAt < RECONNECT_WINDOW_MS
    this.burstSize = recent ? Math.max(this.burstSize, count) : count
    this.burstAt = now
  }

  /** Resolves once a watch is installed or refused. */
  message(ws: NifraWebSocket<LiveSocket>, data: WebSocketData): Promise<void> | undefined {
    // Refused at open or already dropped: a frame still in flight gets no say.
    if (!this.sockets.has(ws)) return undefined
    const state = ws.data
    const now = Date.now()
    state.lastSeen = now
    if (now - state.window >= 60_000) {
      state.window = now
      state.frames = 0
      state.watches = 0
    }
    if (++state.frames > MAX_FRAMES_PER_MINUTE) {
      this.drop(ws, CLOSE_PROTOCOL, "rate")
      return undefined
    }
    if (data === HEARTBEAT) {
      this.send(ws, HEARTBEAT)
      return undefined
    }
    const watch = typeof data === "string" ? parseWatch(data) : undefined
    if (watch === undefined) {
      this.drop(ws, CLOSE_PROTOCOL, "protocol")
      return undefined
    }
    if (++state.watches > MAX_WATCHES_PER_MINUTE) {
      this.drop(ws, CLOSE_PROTOCOL, "rate")
      return undefined
    }
    if (watch.gen <= state.received) return undefined
    state.received = watch.gen
    return this.install(ws, watch).catch(() => this.drop(ws, 1011, "error"))
  }

  private async install(ws: NifraWebSocket<LiveSocket>, watch: Watch): Promise<void> {
    const state = ws.data
    const now = Date.now()
    const prepared: Prepared[] = []
    // One grant per path: the page and each open boundary show different URLs.
    const paths = new Set<string>()
    for (const token of watch.grants) {
      const grant = await this.ring.open(token, now)
      if (grant === undefined || grant.claims.sid !== state.sid) {
        return this.drop(ws, CLOSE_BAD_GRANT, "grant")
      }
      if (paths.has(grant.claims.path)) return this.drop(ws, CLOSE_PROTOCOL, "protocol")
      paths.add(grant.claims.path)
      const owners: { id: string; w: number; hashes: number[] }[] = []
      const tags: string[] = []
      for (const [id, owner] of Object.entries(grant.claims.owners)) {
        owners.push({ id, w: owner.w, hashes: owner.k.map(this.options.hash) })
        tags.push(...(await Promise.all(owner.k.map((key) => this.tagOf(key, grant.secret)))))
      }
      prepared.push({ grant, owners, tags })
    }

    // One synchronous step from here to `ready`.
    if (!this.sockets.has(ws) || ws.readyState !== 1 || state.received !== watch.gen) return
    if (this.down) return this.drop(ws, CLOSE_CAPACITY, "unavailable")
    let sub = state.sub
    for (const { grant } of prepared) {
      const claims = grant.claims
      if (this.revocations.grantRevoked(claims)) return this.drop(ws, CLOSE_REVOKED, "revoked")
      for (const owner of Object.values(claims.owners)) {
        for (const key of owner.k) {
          if (this.revocations.keyRevoked(key, claims)) {
            return this.drop(ws, CLOSE_BAD_GRANT, "grant")
          }
        }
      }
      if (sub !== undefined && sub !== claims.sub) return this.drop(ws, CLOSE_SCOPE, "scope")
      sub = claims.sub
    }
    // At most 3 grants of 64 keys each (`parseWatch`, the keyring): 192 memberships per socket.
    const next = new Set<string>()
    for (const { tags } of prepared) for (const tag of tags) next.add(tag)
    let added = 0
    for (const tag of next) if (!this.members.has(tag)) added++
    const budget = this.options.maxMemberships ?? Number.POSITIVE_INFINITY
    if (
      this.members.size + added > (this.options.maxTopics ?? MAX_TOPICS) ||
      this.memberships - state.tags.size + next.size > budget
    ) {
      return this.drop(ws, CLOSE_CAPACITY, "at capacity")
    }
    state.sub = sub
    for (const tag of state.tags) if (!next.has(tag)) this.leave(ws, tag)
    for (const tag of next) {
      if (state.tags.has(tag)) continue
      this.join(ws, tag)
    }
    // An empty watch does not restart the clock: only holding a tag stops it.
    state.unwatchedSince = next.size === 0 ? (state.unwatchedSince ?? now) : undefined
    // Per grant, in watch order: two frames can hold an owner of the same id.
    const stale: string[][] = []
    let exp = Number.POSITIVE_INFINITY
    for (const { grant, owners } of prepared) {
      exp = Math.min(exp, grant.claims.exp * 1000)
      const changed: string[] = []
      for (const owner of owners) {
        if (
          !this.history.known(owner.w) ||
          owner.hashes.some((hash) => this.history.changedSince(hash, owner.w))
        )
          changed.push(owner.id)
      }
      stale.push(changed)
    }
    state.exp = exp
    this.options.store?.saved(ws, { sub: state.sub ?? null, exp, tags: [...state.tags] })
    this.send(ws, JSON.stringify({ t: "ready", gen: watch.gen, stale }))
  }

  /**
   * A socket whose hub lost its memory but not its connection: its membership comes back as stored.
   * Every revocation since was applied to what is stored, so nothing here is checked again.
   */
  restore(ws: NifraWebSocket<LiveSocket>, stored: StoredSocket | undefined): void {
    this.sockets.add(ws)
    if (stored === undefined) return
    const state = ws.data
    state.sub = stored.sub
    state.exp = stored.exp
    for (const tag of stored.tags) if (!state.tags.has(tag)) this.join(ws, tag)
    if (state.tags.size > 0) state.unwatchedSince = undefined
  }

  private flush(): void {
    this.coalesceTimer = undefined
    for (const [key, pending] of this.coalescing) {
      if (!pending.again) {
        this.coalescing.delete(key)
        continue
      }
      pending.again = false
      this.publishTags(pending.tags)
    }
    if (this.coalescing.size > 0) {
      this.coalesceTimer = unref(setTimeout(() => this.flush(), COALESCE_MS))
    }
  }

  private publishTags(tags: readonly string[]): void {
    for (const tag of tags) {
      const subscribers = this.members.get(tag)
      if (subscribers === undefined) continue
      this.notified += subscribers
      const frame = JSON.stringify({ t: "changed", tag, spread: this.spread(subscribers) })
      for (const publish of this.publishers) publish(this.topic(tag), frame)
    }
  }

  /**
   * How long clients spread their reloads, from this process's subscriber count, rounded up to a few
   * steps so the frame shows no more than its order of magnitude.
   */
  private spread(subscribers: number): number {
    const { instances, reloadRate, spreadFloor } = this.options
    const raw = Math.max(spreadFloor, ((subscribers * instances) / reloadRate) * 1000)
    if (raw <= 100) return 0
    return SPREAD_STEPS.find((step) => step >= raw) ?? 5000
  }

  private join(ws: NifraWebSocket<LiveSocket>, tag: string): void {
    ws.data.tags.add(tag)
    this.members.set(tag, (this.members.get(tag) ?? 0) + 1)
    this.memberships++
    ws.subscribe(this.topic(tag))
  }

  private leave(ws: NifraWebSocket<LiveSocket>, tag: string, open = true): void {
    ws.data.tags.delete(tag)
    if (open) ws.unsubscribe(this.topic(tag))
    this.memberships--
    const count = (this.members.get(tag) ?? 1) - 1
    if (count === 0) this.members.delete(tag)
    else this.members.set(tag, count)
  }

  /** Leave every topic before closing: nothing published after this reaches the socket. */
  private drop(ws: NifraWebSocket<LiveSocket>, code: number, reason: string): void {
    this.forget(ws)
    ws.close(code, reason)
  }

  private forget(ws: NifraWebSocket<LiveSocket>, open = true): void {
    if (!this.sockets.delete(ws)) return
    for (const tag of [...ws.data.tags]) this.leave(ws, tag, open)
    this.options.store?.removed(ws)
    if (this.sockets.size === 0) this.stopSweep()
  }

  private send(ws: NifraWebSocket<LiveSocket>, frame: string): void {
    ws.send(frame)
    if (bufferedOf(ws) > MAX_OUTBOUND_BYTES) this.drop(ws, CLOSE_CAPACITY, "backpressure")
  }

  private topic(tag: string): string {
    return topicOf(this.options.appId, tag)
  }

  /** Read on every open, never cached: a burst of opens must not all pass on one stale reading. */
  private overRss(): boolean {
    const cap = this.options.maxRssBytes
    return cap !== undefined && rss() > cap
  }

  private startSweep(): void {
    if (this.options.store !== undefined) return
    this.sweepTimer ??= unref(setInterval(() => this.sweep(), SWEEP_MS))
  }

  private stopSweep(): void {
    if (this.sweepTimer === undefined) return
    clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  /**
   * Drop the socket when its earliest grant has expired. A host whose sweep can run late (an alarm)
   * asks before every frame it sends.
   */
  expired(ws: NifraWebSocket<LiveSocket>, now: number): boolean {
    if (ws.data.exp > now) return false
    this.drop(ws, CLOSE_BAD_GRANT, "expired")
    return true
  }

  /**
   * Expired grants, silent peers, sockets with nothing to watch and slow readers. Returns the earliest
   * deadline left: a grant expiry, the silence limit, or the end of {@link FIRST_WATCH_MS}; infinite
   * with no socket.
   */
  sweep(): number {
    const now = Date.now()
    const store = this.options.store
    let next = Number.POSITIVE_INFINITY
    for (const ws of [...this.sockets]) {
      const state = ws.data
      const seen =
        store === undefined ? state.lastSeen : Math.max(state.lastSeen, store.lastBeat(ws))
      const unwatched = state.unwatchedSince
      if (state.exp <= now) this.drop(ws, CLOSE_BAD_GRANT, "expired")
      else if (now - seen > IDLE_MS) this.drop(ws, CLOSE_PROTOCOL, "idle")
      else if (unwatched !== undefined && now - unwatched >= FIRST_WATCH_MS) {
        this.drop(ws, CLOSE_UNWATCHED, "unwatched")
      } else if (bufferedOf(ws) > MAX_OUTBOUND_BYTES) this.drop(ws, CLOSE_CAPACITY, "backpressure")
      else {
        const due = Number.isFinite(state.exp) ? state.exp : seen + IDLE_MS
        next = Math.min(next, due, unwatched === undefined ? due : unwatched + FIRST_WATCH_MS)
      }
    }
    return next
  }
}

/** The pub/sub topic of one tag. */
export const topicOf = (appId: string, tag: string): string => `nifra:live:${appId}:${tag}`

/** The wire tag of a key under one listed secret. */
export type TagOf = (key: string, secret: number) => Promise<string>

/** {@link Keyring.tag}, kept: a key's tag changes only with the secrets. Oldest entry out first. */
export function tagCache(ring: Keyring, size = TAG_CACHE_SIZE): TagOf {
  const cache = new Map<string, Promise<string>>()
  return (key, secret) => {
    const name = `${secret}:${key}`
    const cached = cache.get(name)
    if (cached !== undefined) return cached
    if (cache.size >= size) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    const tag = ring.tag(key, secret)
    cache.set(name, tag)
    return tag
  }
}

function parseWatch(text: string): Watch | undefined {
  if (text.length > MAX_FRAME_BYTES || utf8Length(text) > MAX_FRAME_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const { t, gen, grants } = value
  if (t !== "watch" || typeof gen !== "number" || !Number.isSafeInteger(gen) || gen < 0)
    return undefined
  if (!Array.isArray(grants) || grants.length > MAX_WATCH_GRANTS) return undefined
  const list: string[] = []
  for (const grant of grants) {
    if (typeof grant !== "string" || grant.length > MAX_GRANT_CHARS) return undefined
    list.push(grant)
  }
  return { gen, grants: list }
}

function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // A surrogate pair is 4 bytes, counted as 2 + 2.
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code < 0xe000 ? 2 : 3
  }
  return bytes
}

function randomSid(): string {
  let sid = ""
  for (const byte of crypto.getRandomValues(new Uint8Array(16)))
    sid += byte.toString(16).padStart(2, "0")
  return sid
}

/** Bytes queued for a socket: Bun's `getBufferedAmount()`, or a standard socket's `bufferedAmount`. */
function bufferedOf(ws: NifraWebSocket<LiveSocket>): number {
  const raw = ws.raw
  if (typeof raw !== "object" || raw === null) return 0
  if ("getBufferedAmount" in raw && typeof raw.getBufferedAmount === "function") {
    const amount: unknown = raw.getBufferedAmount()
    return typeof amount === "number" ? amount : 0
  }
  if ("bufferedAmount" in raw && typeof raw.bufferedAmount === "number") return raw.bufferedAmount
  return 0
}

function rss(): number {
  const usage = typeof process === "undefined" ? undefined : process.memoryUsage
  return typeof usage?.rss === "function" ? usage.rss() : 0
}

export function unref<T>(timer: T): T {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    const release = timer.unref
    if (typeof release === "function") release.call(timer)
  }
  return timer
}
