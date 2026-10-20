/**
 * Live data refresh, server side. Loaders declare what their data depends on with `ctx.live(...keys)`;
 * a live load returns an encrypted grant for those keys, and the client reloads through the same
 * authorized path whenever one of them changes. Data never travels with a change notice.
 *
 * ```ts
 * import { live } from "@nifrajs/web/live"
 *
 * const liveRuntime = live({ secret: process.env.LIVE_SECRET, subject: (ctx) => sessionUserId(ctx.request) })
 * createWebApp({ ...options, live: liveRuntime })
 * ```
 *
 * Every live load is a `POST` to the load endpoint that runs the target page as a `GET` through the
 * whole app: every hook, middleware, gate and loader sees the target path, exactly as a navigation.
 * Changes reach open pages over one WebSocket per tab, as opaque tags of the keys they watch.
 */
import { isSameOriginForm, replacedRequestOf } from "@nifrajs/core/server"
import { websocket } from "@nifrajs/core/ws"
import {
  LIVE_ATTACH,
  type LiveAttachInput,
  type LiveAttachment,
  type LiveEnvelope,
  type LiveFinish,
  type LiveLoad,
  type LiveRuntimeHandle,
} from "./internal/live-contract.ts"
import { type LiveBus, type LiveBusEvent, memoryBus } from "./live/bus.ts"
import { History, keyHasher } from "./live/history.ts"
import { CLOSE_CAPACITY, LiveHub, type LiveSocket } from "./live/hub.ts"
import {
  assertLiveSecrets,
  createKeyring,
  type GrantOwner,
  KEY_PATTERN,
  type Keyring,
  MAX_GRANT_CHARS,
  MAX_KEYS_PER_FRAME,
  type OpenedGrant,
  SID_PATTERN,
  toBase64Url,
} from "./live/keyring.ts"
import { Revocations } from "./live/revocations.ts"
import type { LoaderContext } from "./manifest.ts"
import { DATA_HEADER, NAV_FROM_HEADER, RETAIN_HEADER } from "./router.ts"

export type {
  LiveBus,
  LiveBusEvent,
  LiveBusInput,
  LiveBusListener,
  LiveBusSubscription,
  LiveChange,
  LiveRevocation,
} from "./live/bus.ts"
export { memoryBus, nextSeq } from "./live/bus.ts"

export interface LiveOptions {
  /**
   * The grant secret, or a rotation list with the newest first (at most 3, each at least 32 bytes).
   * Required in production; development falls back to a random per-process secret.
   */
  readonly secret?: string | readonly string[] | undefined
  /**
   * Who the viewer is: a stable id, or `null` for an anonymous viewer. Called once per live load,
   * after middleware. A grant is only honored for the subject it was issued to.
   */
  readonly subject: (ctx: LoaderContext) => string | null | Promise<string | null>
  /** Separates this app's tags from another app's that shares a secret. Default `"nifra"`. */
  readonly appId?: string
  /** Grant lifetime in seconds. Default 600. */
  readonly grantTtl?: number
  /** The live load endpoint. Default `/_nifra/live/load`. */
  readonly loadPath?: string
  /** The live socket. Default `/_nifra/live`. */
  readonly path?: string
  /** Origins besides the app's own that may call the load endpoint and open the socket. */
  readonly trustedOrigins?: readonly string[]
  /** Live loads running at once in this process; past it the endpoint answers 503. Default 64. */
  readonly maxConcurrentLoads?: number
  /** Live sockets in this process; past it a socket is closed with 1013. Default 10,000. */
  readonly maxSockets?: number
  /** Refuse new sockets while the process's resident memory is above this many bytes. */
  readonly maxRssBytes?: number
  /**
   * The ordered log every process serving the app shares. Default: an in-process bus, right for one
   * process only.
   */
  readonly bus?: LiveBus
  /** Processes serving the app, for spreading reloads. Default 1. */
  readonly instances?: number
  /** Live loads per second the deployment absorbs after one change, for spreading reloads. Default 500. */
  readonly reloadRate?: number
  /** The least time, in ms, clients spread their reloads over. Default 0. */
  readonly spreadFloor?: number
  /**
   * Re-check the keys of owners a load keeps without running their loaders. With it, `renew`
   * re-signs a grant without loaders (every third renewal still runs them all, so a lost change is
   * found within about 27 minutes); without it, `renew` runs a full load. `false` issues no grant.
   */
  readonly authorize?: (keys: readonly string[], ctx: LoaderContext) => boolean | Promise<boolean>
  /**
   * Resolves once a committed write is readable by every loader, such as a read replica catching up.
   * `publish` waits for it, so no client reloads before its data can show the change. Replica-backed
   * reads need it; without it a publish goes out as soon as it is called.
   */
  readonly visible?: () => void | Promise<void>
}

/** A live runtime: pass it to `createWebApp({ live })`. */
export interface Live extends LiveRuntimeHandle {
  /** Resolves once the secrets are derived and the bus is read; rejects on a duplicate secret id. */
  readonly ready: Promise<void>
  /**
   * `keys` changed: every open page watching one reloads it. Call it after the write is visible to
   * loaders; resolves once this process has applied it.
   */
  publish(...keys: string[]): Promise<void>
  /** Refuse every grant issued to `subject` before now, and close its sockets. */
  revoke(subject: string): Promise<void>
  /** Refuse every grant issued before now, and close every socket. */
  revokeAll(): Promise<void>
  /**
   * Access to `key` was removed (for everyone, or for one subject): every watcher gets one last change
   * for it and stops watching it, and no grant issued before now keeps or re-signs it, so the next load
   * runs that owner's loader, which decides again.
   */
  revokeKey(key: string, subject?: string): Promise<void>
}

const DEFAULT_LOAD_PATH = "/_nifra/live/load"
const DEFAULT_SOCKET_PATH = "/_nifra/live"
const DEFAULT_TTL_SECONDS = 600
const DEFAULT_MAX_LOADS = 64
const DEFAULT_MAX_SOCKETS = 10_000
const DEFAULT_RELOAD_RATE = 500
const DEFAULT_APP_ID = "nifra"
const MAX_BODY_BYTES = 65_536
const MAX_PATH_CHARS = 2048
const MAX_GRANTS = 3
const MAX_RETAIN = 64
const MAX_OWNER_CHARS = 512
const PAGE_FRAME = "page"
/** Renewals re-signed without loaders before one runs them all. */
const MAX_QUIET_RENEWALS = 2

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]
const BODY_HEADERS = ["content-length", "content-type", "content-encoding"]
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const NO_STORE = "private, no-store"

interface LoadBody {
  readonly path: string
  readonly sid: string
  readonly frame: string
  readonly mode: "load" | "renew"
  readonly retain: readonly string[]
  readonly grants: readonly string[]
}

/** What the runtime holds once the keyring is derived and the bus subscribed. */
interface Core {
  readonly ring: Keyring
  readonly history: History
  readonly revocations: Revocations
  readonly hub: LiveHub
}

type Queued =
  | { readonly kind: "event"; readonly event: LiveBusEvent }
  | { readonly kind: "gap"; readonly head: number }
  | { readonly kind: "down" }

/** Create the live runtime for one app. */
export function live(options: LiveOptions): Live {
  if (typeof options.subject !== "function") {
    throw new TypeError("[nifra/web] live: `subject` must be a function returning a string or null")
  }
  const ttl = options.grantTtl ?? DEFAULT_TTL_SECONDS
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 86_400) {
    throw new TypeError(
      "[nifra/web] live: `grantTtl` must be a whole number of seconds from 60 to 86400",
    )
  }
  const maxLoads = positive(options.maxConcurrentLoads, DEFAULT_MAX_LOADS, "maxConcurrentLoads")
  const maxSockets = positive(options.maxSockets, DEFAULT_MAX_SOCKETS, "maxSockets")
  const instances = positive(options.instances, 1, "instances")
  const reloadRate = positive(options.reloadRate, DEFAULT_RELOAD_RATE, "reloadRate")
  const spreadFloor = options.spreadFloor ?? 0
  if (!Number.isSafeInteger(spreadFloor) || spreadFloor < 0 || spreadFloor > 5000) {
    throw new TypeError("[nifra/web] live: `spreadFloor` must be a whole number of ms up to 5000")
  }
  const maxRssBytes = options.maxRssBytes
  if (maxRssBytes !== undefined) positive(maxRssBytes, 1, "maxRssBytes")
  const loadPath = endpointPath(options.loadPath ?? DEFAULT_LOAD_PATH, "loadPath")
  const socketPath = endpointPath(options.path ?? DEFAULT_SOCKET_PATH, "path")
  if (socketPath === loadPath) {
    throw new TypeError("[nifra/web] live: `path` and `loadPath` must differ")
  }
  const appId = options.appId ?? DEFAULT_APP_ID
  if (typeof appId !== "string" || appId === "" || appId.length > 128) {
    throw new TypeError(
      "[nifra/web] live: `appId` must be a non-empty string of at most 128 characters",
    )
  }
  const secrets = secretsOf(options.secret)
  assertLiveSecrets(secrets)
  const trusted = new Set(options.trustedOrigins ?? [])
  const authorize = options.authorize
  const visible = options.visible
  const subjectOf = options.subject
  const production = isProduction()
  const bus = options.bus ?? memoryBus()
  const hash = keyHasher()
  const publishers: ((topic: string, frame: string) => void)[] = []

  // Bus events wait here until the core exists, then apply in seq order: their tags are derived
  // first (async), then each is recorded and fanned out in one synchronous step.
  const queue: Queued[] = []
  let draining = false
  let core: Core | undefined
  /** The last bus seq this process applied: a load reads it before any loader runs. */
  let seen = 0
  const waiters: { readonly seq: number; readonly resolve: () => void }[] = []

  const started: Promise<Core> = (async () => {
    const ring = await createKeyring({ secrets, appId, ttl })
    const subscription = await bus.subscribe({
      event: (event) => enqueue({ kind: "event", event }),
      gap: (head) => enqueue({ kind: "gap", head }),
      down: () => enqueue({ kind: "down" }),
    })
    seen = subscription.head
    const history = new History(subscription.head)
    const revocations = new Revocations(subscription.head, ttl * 1000)
    const hub = new LiveHub(
      ring,
      history,
      revocations,
      { appId, trusted, maxSockets, maxRssBytes, reloadRate, instances, spreadFloor, hash },
      publishers,
    )
    core = { ring, history, revocations, hub }
    void drain()
    return core
  })()
  // `ready` carries a failed start; nothing else may leave it unhandled.
  started.catch(() => {})

  function enqueue(item: Queued): void {
    queue.push(item)
    void drain()
  }

  async function drain(): Promise<void> {
    if (draining || core === undefined) return
    draining = true
    try {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        await apply(core, item)
      }
    } finally {
      draining = false
    }
  }

  async function apply(c: Core, item: Queued): Promise<void> {
    if (item.kind === "down") {
      c.hub.down = true
      c.hub.closeAll(CLOSE_CAPACITY, "unavailable")
      return
    }
    if (item.kind === "gap") return forgetUntil(c, item.head)
    const event = item.event
    // At-least-once delivery: a repeat is already applied.
    if (!Number.isSafeInteger(event.seq) || event.seq <= seen) return
    try {
      if (event.type === "change") {
        const keys = event.keys.filter((key) => typeof key === "string" && KEY_PATTERN.test(key))
        const tags = await Promise.all(keys.map((key) => c.hub.tagsOf(key)))
        // One synchronous step: history first, then the frames.
        c.history.record(
          event.seq,
          keys.map((key) => hash(key)),
          Date.now(),
        )
        c.hub.change(keys, tags)
      } else {
        if (!validRevocation(event)) throw new TypeError("malformed revocation")
        const tags = event.key === null ? [] : await c.hub.tagsOf(event.key)
        c.revocations.apply(event, Date.now())
        c.history.advance(event.seq, Date.now())
        c.hub.revoke(event, tags)
      }
      settle(event.seq)
    } catch (err) {
      // An event this process could not apply leaves its history and revocations unknown.
      console.error("[nifra/web] live: a bus event could not be applied; closing live sockets", err)
      forgetUntil(c, event.seq)
    }
  }

  /** Everything up to `head` is unknown: refuse older grants, report all owners stale, reconnect. */
  function forgetUntil(c: Core, head: number): void {
    // Never behind what this process applied: loads already issued watermarks up to `seen`.
    const at = Math.max(head, seen)
    c.history.reset(at)
    c.revocations.raise(at)
    c.hub.down = false
    c.hub.closeAll(CLOSE_CAPACITY, "resync")
    settle(at)
  }

  function settle(seq: number): void {
    if (seq > seen) seen = seq
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]
      if (waiter !== undefined && waiter.seq <= seen) {
        waiters.splice(i, 1)
        waiter.resolve()
      }
    }
  }

  /** Append to the bus, then wait until this process has applied it. */
  async function append(input: Parameters<LiveBus["append"]>[0]): Promise<void> {
    await started
    const seq = await bus.append(input)
    if (seq <= seen) return
    await new Promise<void>((resolve) => waiters.push({ seq, resolve }))
  }

  let inflight = 0
  let entering = 0

  const attach = (input: LiveAttachInput): LiveAttachment => {
    const loads = new WeakMap<Request, LoadState>()
    const app = input.app
    publishers.push((topic, frame) => app.publish(topic, frame))
    // The socket carries no authority before a watch, so it is registered before any app guard.
    app.use(websocket())
    app.ws<LiveSocket>(socketPath, {
      // Decided in `upgrade`, which has the request: a missing or `null` Origin is refused there.
      allowedOrigins: () => true,
      upgrade: async (c) => (await started).hub.upgrade(c.req),
      // A socket opens only after its `upgrade` awaited the start, so the core exists by then.
      open: (ws) => core?.hub.open(ws),
      message: (ws, data) => core?.hub.message(ws, data),
      close: (ws) => core?.hub.close(ws),
    })

    const admitLoad = async (req: Request): Promise<Request | Response> => {
      const origin = req.headers.get("origin")
      if (
        origin === null ||
        !(trusted.has(origin) || isSameOriginForm(origin, req.headers.get("sec-fetch-site"), req))
      ) {
        return refusal(403, "forbidden_origin")
      }
      const type = req.headers.get("content-type")
      if (type === null || mediaType(type) !== "application/json") {
        return refusal(415, "unsupported_media_type")
      }
      if (inflight + entering >= maxLoads) return busy()
      // Reading the body and opening grants count too: forged grants cannot buy unbounded key
      // derivation.
      entering++
      try {
        return await prepareLoad(req)
      } finally {
        entering--
      }
    }

    const prepareLoad = async (req: Request): Promise<Request | Response> => {
      const text = await readCapped(req, MAX_BODY_BYTES)
      if (typeof text === "number") return refusal(text, text === 413 ? "too_large" : "bad_request")
      const body = parseBody(text)
      if (body === undefined) return refusal(400, "bad_request")
      const path = canonicalPath(body.path, req.url)
      if (path === undefined) return refusal(400, "bad_path")
      const c = await started
      // Read before any hook, middleware or loader runs: every owner loaded fresh is at least this new.
      const loadSeq = seen
      const match = input.matchRoute(path)
      const now = Date.now()
      let grant: OpenedGrant | undefined
      // With the bus unreachable, revocations are unknown: nothing presented is honored.
      for (const token of c.hub.down ? [] : body.grants) {
        const opened = await c.ring.open(token, now)
        if (opened === undefined) continue
        const claims = opened.claims
        if (claims.sid !== body.sid || claims.path !== path || claims.frame !== body.frame) continue
        if (c.revocations.grantRevoked(claims)) continue
        grant = opened
        break
      }
      const requested =
        grant === undefined
          ? []
          : body.mode === "load"
            ? body.retain
            : authorize === undefined || grant.claims.r >= MAX_QUIET_RENEWALS
              ? []
              : Object.keys(grant.claims.owners)
      const layouts: number[] = []
      let retainPage = false
      if (grant !== undefined && match !== null) {
        const claims = grant.claims
        for (const owner of requested) {
          const held = Object.hasOwn(claims.owners, owner) ? claims.owners[owner] : undefined
          if (held === undefined) continue
          // A key revoked since issuance is never kept or re-signed: its loader runs and decides again.
          if (held.k.some((key) => c.revocations.keyRevoked(key, claims))) continue
          if (owner.startsWith("L:")) {
            const index = match.layoutIds.indexOf(owner.slice(2))
            if (index !== -1 && !layouts.includes(index)) layouts.push(index)
          } else if (owner === `P:${match.routeId}`) {
            retainPage = true
          }
        }
      }
      const headers = internalHeaders(req.headers)
      if (layouts.length > 0) {
        headers.set(RETAIN_HEADER, layouts.sort((a, b) => a - b).join(","))
        headers.set(NAV_FROM_HEADER, path)
      }
      const target = new Request(new URL(path, req.url), {
        method: "GET",
        headers,
        signal: req.signal,
      })
      loads.set(
        target,
        new LoadState(c, body, path, loadSeq, grant, match?.routeId ?? "", retainPage),
      )
      return target
    }

    return {
      onRequest: (req) =>
        req.method === "POST" && pathnameOf(req.url) === loadPath ? admitLoad(req) : undefined,
      loadOf: (req) => {
        // An app hook after the endpoint may hand on a replacement; the load is its original's.
        let current: Request | undefined = req
        for (let hops = 0; current !== undefined && hops < 16; hops++) {
          const load = loads.get(current)
          if (load !== undefined) return load
          current = replacedRequestOf(current)
        }
        return undefined
      },
    }
  }

  class LoadState implements LiveLoad {
    retainPage: boolean
    private subject: string | null = null
    private admitted = false
    private released = false
    private declared = 0
    /** Keys past the frame budget: counted for the log, never stored. */
    private dropped = 0
    private readonly collectors = new Map<string, { keys: Set<string>; sealed: boolean }>()

    constructor(
      private readonly core: Core,
      private readonly body: LoadBody,
      private readonly path: string,
      private readonly seq: number,
      private readonly grant: OpenedGrant | undefined,
      readonly routeId: string,
      retainPage: boolean,
    ) {
      this.retainPage = retainPage
    }

    admit(): Response | undefined {
      if (inflight >= maxLoads) return busy()
      inflight++
      this.admitted = true
      return undefined
    }

    release(): void {
      if (!this.admitted || this.released) return
      this.released = true
      inflight--
    }

    settle(response: Response): Response {
      if (
        response.body !== null &&
        mediaType(response.headers.get("content-type") ?? "") === "application/x-ndjson"
      ) {
        // Deferred values are still loading while the body streams: the slot is held until it ends.
        return new Response(
          releasing(response.body, () => this.release()),
          response,
        )
      }
      this.release()
      return response
    }

    async bind(ctx: LoaderContext): Promise<boolean> {
      const subject = await subjectOf(ctx)
      if (subject !== null && typeof subject !== "string") {
        throw new TypeError("[nifra/web] live: `subject` must return a string or null")
      }
      this.subject = subject
      if (this.grant === undefined || this.grant.claims.sub === subject) return true
      this.retainPage = false
      return false
    }

    collector(owner: string): (...keys: string[]) => void {
      let entry = this.collectors.get(owner)
      if (entry === undefined) {
        entry = { keys: new Set(), sealed: false }
        this.collectors.set(owner, entry)
      }
      const collected = entry
      return (...keys) => {
        if (collected.sealed) {
          throw new TypeError(
            `[nifra/web] ctx.live() was called after the loader of "${owner}" settled; declare keys before the loader returns`,
          )
        }
        for (const key of keys) {
          if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
            throw new TypeError(
              "[nifra/web] ctx.live() keys are a letter followed by up to 127 of A-Z a-z 0-9 . _ : / -",
            )
          }
          if (collected.keys.has(key)) continue
          if (this.declared >= MAX_KEYS_PER_FRAME) {
            if (!production) {
              throw new RangeError(
                `[nifra/web] a live frame holds at most ${MAX_KEYS_PER_FRAME} keys; "${owner}" declared one more`,
              )
            }
            this.dropped++
            continue
          }
          collected.keys.add(key)
          this.declared++
        }
      }
    }

    seal(owner: string): void {
      const entry = this.collectors.get(owner)
      if (entry !== undefined) entry.sealed = true
    }

    /** A renewal that kept owners counts one more; a load that ran every loader starts over. */
    private renewals(kept: boolean): number {
      const previous = this.grant?.claims.r ?? 0
      if (!kept) return 0
      return this.body.mode === "renew" ? previous + 1 : previous
    }

    async finish(input: LiveFinish): Promise<LiveEnvelope> {
      for (const entry of this.collectors.values()) entry.sealed = true
      const ring = this.core.ring
      const subject = await ring.subjectTag(this.subject)
      const pageRetained = input.retained.some((owner) => owner.startsWith("P:"))
      const bare: LiveEnvelope = pageRetained ? { subject, page: "retained" } : { subject }
      // No socket would accept a grant now, and revocations are unknown: the client polls.
      if (this.core.hub.down) return bare
      const owners: Record<string, GrantOwner> = {}
      const carried = new Set<string>()
      for (const owner of input.retained) {
        const held =
          this.grant !== undefined && Object.hasOwn(this.grant.claims.owners, owner)
            ? this.grant.claims.owners[owner]
            : undefined
        // Kept data with no grant behind it cannot be vouched for.
        if (held === undefined) return bare
        owners[owner] = { k: held.k, w: held.w }
        for (const key of held.k) carried.add(key)
      }
      if (
        carried.size > 0 &&
        authorize !== undefined &&
        !(await authorize([...carried], input.ctx))
      ) {
        return bare
      }
      let count = this.dropped
      for (const owner of input.fresh) {
        const keys = [...(this.collectors.get(owner)?.keys ?? [])]
        owners[owner] = { k: keys, w: this.seq }
      }
      for (const owner of Object.values(owners)) count += owner.k.length
      if (count > MAX_KEYS_PER_FRAME) {
        if (!production) {
          throw new RangeError(
            `[nifra/web] a live frame holds at most ${MAX_KEYS_PER_FRAME} keys; route "${this.routeId}" declared ${count}`,
          )
        }
        console.error(
          `[nifra/web] live: route "${this.routeId}" declared ${count} keys, over the ${MAX_KEYS_PER_FRAME}-key frame budget; no grant issued, the client polls`,
        )
        return bare
      }
      const grant = await ring.seal(
        {
          sid: this.body.sid,
          sub: this.subject,
          path: this.path,
          frame: this.body.frame,
          owners,
          s: this.seq,
          r: this.renewals(input.retained.length > 0),
        },
        Date.now(),
      )
      if (grant === undefined) {
        console.error(
          `[nifra/web] live: no grant issued for route "${this.routeId}" (over ${MAX_GRANT_CHARS} characters, or the subkey's seal limit); the client polls`,
        )
        return bare
      }
      const keys = [...new Set(Object.values(owners).flatMap((owner) => owner.k))]
      const tags: Record<string, string[]> = {}
      for (const key of keys) {
        const owning: string[] = []
        for (const [name, owner] of Object.entries(owners))
          if (owner.k.includes(key)) owning.push(name)
        tags[await ring.tag(key)] = owning
      }
      return { ...bare, grant, tags }
    }
  }

  const checkKey = (key: unknown, method: string): string => {
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      throw new TypeError(`[nifra/web] live.${method} takes keys in the ctx.live() charset`)
    }
    return key
  }

  return {
    ready: started.then(() => undefined),
    async publish(...keys) {
      for (const key of keys) checkKey(key, "publish")
      if (keys.length === 0) return
      await visible?.()
      await append({ type: "change", keys: [...new Set(keys)] })
    },
    async revoke(subject) {
      if (typeof subject !== "string")
        throw new TypeError("[nifra/web] live.revoke takes a subject")
      await append({ type: "revoke", sub: subject, key: null })
    },
    async revokeAll() {
      await append({ type: "revoke", sub: null, key: null })
    },
    async revokeKey(key, subject) {
      checkKey(key, "revokeKey")
      if (subject !== undefined && typeof subject !== "string") {
        throw new TypeError("[nifra/web] live.revokeKey takes an optional subject string")
      }
      await append({ type: "revoke", sub: subject ?? null, key })
    },
    [LIVE_ATTACH]: attach,
  }
}

function validRevocation(event: LiveBusEvent): boolean {
  if (event.type !== "revoke") return false
  if (event.sub !== null && typeof event.sub !== "string") return false
  return event.key === null || (typeof event.key === "string" && KEY_PATTERN.test(event.key))
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`[nifra/web] live: \`${name}\` must be a positive whole number`)
  }
  return resolved
}

function endpointPath(path: string, name: string): string {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[?#\s]/.test(path)
  ) {
    throw new TypeError(`[nifra/web] live: \`${name}\` must be an absolute path with no query`)
  }
  return path
}

function secretsOf(secret: LiveOptions["secret"]): readonly unknown[] {
  if (secret === undefined || (Array.isArray(secret) && secret.length === 0) || secret === "") {
    if (isProduction()) {
      throw new TypeError(
        "[nifra/web] live: `secret` is required in production. Generate one with: openssl rand -base64 32",
      )
    }
    return [toBase64Url(crypto.getRandomValues(new Uint8Array(32)))]
  }
  return typeof secret === "string" ? [secret] : secret
}

const isProduction = (): boolean =>
  typeof process !== "undefined" && process.env?.NODE_ENV === "production"

const mediaType = (value: string): string => {
  const end = value.indexOf(";")
  return (end === -1 ? value : value.slice(0, end)).trim().toLowerCase()
}

function pathnameOf(url: string): string {
  const start = url.indexOf("/", url.indexOf("//") + 2)
  if (start === -1) return "/"
  const query = url.indexOf("?", start)
  return query === -1 ? url.slice(start) : url.slice(start, query)
}

function refusal(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "cache-control": NO_STORE } })
}

function busy(): Response {
  return Response.json(
    { error: "live_load_busy" },
    {
      status: 503,
      headers: {
        "cache-control": NO_STORE,
        "retry-after": String(1 + Math.floor(Math.random() * 3)),
      },
    },
  )
}

/** The body as text, or the status to refuse it with. */
async function readCapped(req: Request, max: number): Promise<string | 400 | 413> {
  const declared = req.headers.get("content-length")
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return 400
    if (Number(declared) > max) return 413
  }
  if (req.body === null) return ""
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await Promise.allSettled([reader.cancel()])
      return 413
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return 400
  }
}

function parseBody(text: string): LoadBody | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const { path, sid, frame, mode, retain = [], grants = [] } = value
  if (typeof path !== "string" || typeof sid !== "string" || !SID_PATTERN.test(sid))
    return undefined
  // Phase 2 serves the page frame; boundary frames arrive with the client's frame support.
  if (frame !== PAGE_FRAME || (mode !== "load" && mode !== "renew")) return undefined
  if (!isStringList(retain, MAX_RETAIN, MAX_OWNER_CHARS)) return undefined
  if (!isStringList(grants, MAX_GRANTS, MAX_GRANT_CHARS)) return undefined
  return { path, sid, frame, mode, retain, grants }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isStringList = (value: unknown, max: number, chars: number): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((item) => typeof item === "string" && item.length <= chars)

/** `path` when it is already the canonical same-origin `pathname + search`; anything else is refused. */
function canonicalPath(path: string, base: string): string | undefined {
  if (path.length > MAX_PATH_CHARS || !path.startsWith("/") || path.startsWith("//"))
    return undefined
  // An absolute path against a request URL always parses: the parser normalises, it never throws.
  const url = new URL(path, base)
  const canonical = url.pathname + url.search
  return url.origin === new URL(base).origin && canonical === path ? canonical : undefined
}

/**
 * The headers the router's own data request for the target would carry: the POST's, without the
 * hop-by-hop, body and `origin` headers a same-origin GET does not send, and without any `x-nifra-*`
 * the client sent. `sec-fetch-*` pass through: a browser's fetch sends the same values for both.
 */
function internalHeaders(post: Headers): Headers {
  const headers = new Headers(post)
  const nominated = headers.get("connection")
  if (nominated !== null) {
    for (const name of nominated.split(",")) {
      const trimmed = name.trim()
      if (TOKEN.test(trimmed)) headers.delete(trimmed)
    }
  }
  for (const name of HOP_BY_HOP) headers.delete(name)
  for (const name of BODY_HEADERS) headers.delete(name)
  headers.delete("origin")
  const own: string[] = []
  headers.forEach((_value, name) => {
    if (name.startsWith("x-nifra-")) own.push(name)
  })
  for (const name of own) headers.delete(name)
  headers.set(DATA_HEADER, "1")
  return headers
}

function releasing(body: ReadableStream<Uint8Array>, done: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Released on the last chunk and on a read that throws: only an enqueue keeps the slot.
      let finished = true
      try {
        const chunk = await reader.read()
        if (chunk.done) controller.close()
        else {
          finished = false
          controller.enqueue(chunk.value)
        }
      } finally {
        if (finished) done()
      }
    },
    cancel(reason) {
      done()
      return reader.cancel(reason)
    },
  })
}
