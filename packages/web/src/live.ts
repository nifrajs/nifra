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
import { queryDigester, querySalt } from "./internal/query-digest.ts"
import { type LiveBus, type LiveBusEvent, type LiveBusInput, memoryBus } from "./live/bus.ts"
import { applyEvent, type LiveCore } from "./live/core.ts"
import { History, keyHasher } from "./live/history.ts"
import { CLOSE_CAPACITY, LiveHub, type LiveSocket, tagCache, unref } from "./live/hub.ts"
import {
  HUB_APPEND_PATH,
  HUB_AUTHORITY_PATH,
  HUB_CONFIG_HEADER,
  HUB_ORIGIN,
  hubConfigOf,
  hubName,
  type LiveHubNamespace,
  MAX_APPEND_KEYS,
  parseAuthorityReply,
  parseSeq,
} from "./live/hub-protocol.ts"
import {
  assertLiveSecrets,
  createKeyring,
  type GrantClaims,
  type GrantOwner,
  KEY_PATTERN,
  type Keyring,
  MAX_GRANT_CHARS,
  MAX_KEYS_PER_FRAME,
  type OpenedGrant,
  SID_PATTERN,
  toBase64Url,
} from "./live/keyring.ts"
import { readCapped } from "./live/read-capped.ts"
import { type RevocationCheck, Revocations, RevocationView } from "./live/revocations.ts"
import {
  appIdOf,
  DEFAULT_MAX_SOCKETS,
  DEFAULT_RELOAD_RATE,
  grantTtlOf,
  positive,
  spreadFloorOf,
} from "./live/settings.ts"
import type { LoaderContext } from "./manifest.ts"
import {
  DATA_HEADER,
  HOLE_FILL_HEADER,
  KEEP_HOLES_HEADER,
  NAV_FROM_HEADER,
  RETAIN_HEADER,
} from "./router.ts"

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
  /** Grant lifetime in seconds, at most 3600. Default 600. */
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
  /**
   * Cloudflare Workers: the Durable Object namespace of the app's live hub (`liveHub()` from
   * `@nifrajs/web/live-hub`). The hub owns the log and holds the sockets; this isolate forwards the
   * socket handshake to it, asks it for the seq and the revocations each load needs, and publishes
   * through it. Exclusive with `bus`.
   */
  readonly hub?: LiveHubNamespace
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
  /**
   * Let query hooks refetch on the keys a page's loaders grant (`useQuery(key, fn, { live })`). Each
   * live load then carries a salted digest of every key it grants: page code can confirm a guess at
   * one of them, so leave it off when key names hold anything the viewer should not see.
   */
  readonly queryKeys?: boolean
}

/** A live runtime: pass it to `createWebApp({ live })`. */
export interface Live extends LiveRuntimeHandle {
  /** Resolves once the secrets are derived and the bus is read; rejects on a duplicate secret id. */
  readonly ready: Promise<void>
  /**
   * `keys` changed: every open page watching one reloads it. Call it after the write is visible to
   * loaders; resolves once this process has applied it, or 2 s after the bus took it if this process
   * has not read it back by then.
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
const DEFAULT_MAX_LOADS = 64
const MAX_BODY_BYTES = 65_536
const MAX_PATH_CHARS = 2048
const MAX_GRANTS = 3
const MAX_RETAIN = 64
const MAX_OWNER_CHARS = 512
/** A partially prerendered page has at most 32 holes, each named in at most 32 characters. */
const MAX_HOSTS = 32
const MAX_HOST_CHARS = 32
const HOST = /^[a-z0-9-]+$/
const PAGE_FRAME = "page"
/** Renewals re-signed without loaders before one runs them all. */
const MAX_QUIET_RENEWALS = 2
/** How long a publish waits to read its own event back; the event is in the log either way. */
const APPLY_WAIT_MS = 2000

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
  /** The holes whose hosts the page holds: each reloads as a fill. */
  readonly fill: readonly string[]
}

/** What the runtime holds once the keyring is derived and the bus subscribed. */
type Core = LiveCore

interface AuthorityState {
  /** A load's watermark: every owner it loads fresh is at least this new. */
  readonly seq: number
  /** The log is unreachable: nothing presented is honored and no grant is issued. */
  readonly down: boolean
  readonly revocations: RevocationCheck
}

interface Authority {
  readonly ring: Keyring
  check(claims: readonly GrantClaims[]): Promise<AuthorityState>
}

const REFUSE_ALL: RevocationCheck = { grantRevoked: () => true, keyRevoked: () => true }

type Queued =
  | { readonly kind: "event"; readonly event: LiveBusEvent }
  | { readonly kind: "gap"; readonly head: number }
  | { readonly kind: "down" }

/** Create the live runtime for one app. */
export function live(options: LiveOptions): Live {
  if (typeof options.subject !== "function") {
    throw new TypeError("[nifra/web] live: `subject` must be a function returning a string or null")
  }
  const ttl = grantTtlOf(options.grantTtl)
  const maxLoads = positive(options.maxConcurrentLoads, DEFAULT_MAX_LOADS, "maxConcurrentLoads")
  const maxSockets = positive(options.maxSockets, DEFAULT_MAX_SOCKETS, "maxSockets")
  const instances = positive(options.instances, 1, "instances")
  const reloadRate = positive(options.reloadRate, DEFAULT_RELOAD_RATE, "reloadRate")
  const spreadFloor = spreadFloorOf(options.spreadFloor)
  const maxRssBytes = options.maxRssBytes
  if (maxRssBytes !== undefined) positive(maxRssBytes, 1, "maxRssBytes")
  const loadPath = endpointPath(options.loadPath ?? DEFAULT_LOAD_PATH, "loadPath")
  const socketPath = endpointPath(options.path ?? DEFAULT_SOCKET_PATH, "path")
  if (socketPath === loadPath) {
    throw new TypeError("[nifra/web] live: `path` and `loadPath` must differ")
  }
  const appId = appIdOf(options.appId)
  const hubNamespace = options.hub
  if (hubNamespace !== undefined && noSecret(options.secret)) {
    // A per-process fallback secret would differ from the hub's: no grant would ever open there.
    throw new TypeError("[nifra/web] live: `hub` needs `secret`, the same one the hub is given")
  }
  const secrets = secretsOf(options.secret)
  assertLiveSecrets(secrets)
  const trusted = new Set(options.trustedOrigins ?? [])
  const authorize = options.authorize
  const visible = options.visible
  const subjectOf = options.subject
  const queryKeys = options.queryKeys === true
  const production = isProduction()
  if (hubNamespace !== undefined) {
    if (options.bus !== undefined) {
      throw new TypeError("[nifra/web] live: `hub` and `bus` are exclusive; the hub owns the log")
    }
    if (typeof hubNamespace?.idFromName !== "function" || typeof hubNamespace.get !== "function") {
      throw new TypeError("[nifra/web] live: `hub` must be the live hub's Durable Object namespace")
    }
  }
  const bus = options.bus ?? memoryBus()
  const hash = keyHasher()
  const publishers = new Set<(topic: string, frame: string) => void>()

  // Bus events wait here until the core exists, then apply in seq order: their tags are derived
  // first (async), then each is recorded and fanned out in one synchronous step.
  const queue: Queued[] = []
  let draining = false
  let core: Core | undefined
  /** The last bus seq this process applied: a load reads it before any loader runs. */
  let seen = 0
  const waiters: { readonly seq: number; readonly resolve: () => void }[] = []
  /** A publish already found this process behind the bus; the next applied event clears it. */
  let lagging = false

  const keyring = createKeyring({ secrets, appId, ttl })
  // One cache for the tags a load hands out and the tags this process's sockets join.
  const tags = keyring.then((ring) => tagCache(ring))
  tags.catch(() => {})
  const started: Promise<Core> = (async () => {
    const ring = await keyring
    // On Workers the hub holds the log: this isolate reads nothing.
    if (hubNamespace !== undefined) return new Promise<Core>(() => {})
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
      {
        appId,
        trusted,
        maxSockets,
        maxRssBytes,
        reloadRate,
        instances,
        spreadFloor,
        hash,
        tags: await tags,
      },
      publishers,
    )
    core = { ring, history, revocations, hub }
    void drain()
    return core
  })()
  // `ready` carries a failed start; nothing else may leave it unhandled.
  started.catch(() => {})

  /** What a load checks its grants against: this process's own core, or the Workers hub. */
  const authority: Promise<Authority> =
    hubNamespace === undefined
      ? started.then((c) => ({
          ring: c.ring,
          check: async () => ({ seq: seen, down: c.hub.down, revocations: c.revocations }),
        }))
      : keyring.then((ring) => ({ ring, check: (claims) => hubCheck(hubNamespace, ring, claims) }))
  authority.catch(() => {})

  /** One call through the binding; `undefined` when the hub is unreachable or answers wrong. */
  async function hubCall(
    namespace: LiveHubNamespace,
    ring: Keyring,
    path: string,
    body: unknown,
  ): Promise<unknown> {
    try {
      const stub = namespace.get(namespace.idFromName(hubName(appId)))
      const res = await stub.fetch(
        new Request(`${HUB_ORIGIN}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", [HUB_CONFIG_HEADER]: hubConfigOf(ring) },
          body: JSON.stringify(body),
        }),
      )
      if (!res.ok) {
        await res.body?.cancel()
        return undefined
      }
      return await res.json()
    } catch {
      return undefined
    }
  }

  async function hubCheck(
    namespace: LiveHubNamespace,
    ring: Keyring,
    claims: readonly GrantClaims[],
  ): Promise<AuthorityState> {
    const subjects = [
      ...new Set(claims.flatMap((claim) => (claim.sub === null ? [] : [claim.sub]))),
    ]
    const keys = [
      ...new Set(
        claims.flatMap((claim) => Object.values(claim.owners).flatMap((owner) => owner.k)),
      ),
    ]
    const reply = parseAuthorityReply(
      await hubCall(namespace, ring, HUB_AUTHORITY_PATH, { subjects, keys }),
    )
    // Unreachable: revocations are unknown, so nothing presented is honored and no grant is issued.
    if (reply === undefined) return { seq: 0, down: true, revocations: REFUSE_ALL }
    return { seq: reply.seq, down: false, revocations: new RevocationView(reply) }
  }

  /** The handshake goes to the hub, which holds every socket; it checks the Origin itself. */
  async function forwardSocket(namespace: LiveHubNamespace, req: Request): Promise<Response> {
    try {
      return await namespace.get(namespace.idFromName(hubName(appId))).fetch(req)
    } catch {
      return Response.json({ error: "unavailable" }, { status: 503 })
    }
  }

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
      await applyEvent(c, event, hash)
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
    lagging = false
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]
      if (waiter !== undefined && waiter.seq <= seen) {
        waiters.splice(i, 1)
        waiter.resolve()
      }
    }
  }

  /** Append to the bus, then wait until this process has applied it, at most {@link APPLY_WAIT_MS}. */
  async function append(input: Parameters<LiveBus["append"]>[0]): Promise<void> {
    if (hubNamespace !== undefined) return appendToHub(hubNamespace, input)
    await started
    const seq = await bus.append(input)
    if (seq <= seen) return
    await new Promise<void>((resolve) => {
      const waiter = {
        seq,
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
      }
      // A reader that stalled would hold every publish, and every action awaiting one, for good.
      const timer = unref(
        setTimeout(() => {
          const at = waiters.indexOf(waiter)
          if (at !== -1) waiters.splice(at, 1)
          if (!lagging) {
            lagging = true
            console.error(
              `[nifra/web] live: this process did not read a publish back from the bus within ${APPLY_WAIT_MS} ms; its sockets miss changes until the bus reader recovers`,
            )
          }
          resolve()
        }, APPLY_WAIT_MS),
      )
      waiters.push(waiter)
    })
  }

  /** The hub takes at most {@link MAX_APPEND_KEYS} keys a call: a larger change goes as several. */
  async function appendToHub(namespace: LiveHubNamespace, input: LiveBusInput): Promise<void> {
    const ring = await keyring
    const parts: LiveBusInput[] = []
    if (input.type === "change") {
      for (let at = 0; at < input.keys.length; at += MAX_APPEND_KEYS) {
        parts.push({ type: "change", keys: input.keys.slice(at, at + MAX_APPEND_KEYS) })
      }
    } else parts.push(input)
    for (let at = 0; at < parts.length; at++) {
      if (parseSeq(await hubCall(namespace, ring, HUB_APPEND_PATH, parts[at])) === undefined) {
        const published = at * MAX_APPEND_KEYS
        throw new Error(
          published === 0
            ? "[nifra/web] live: the hub did not take the event; nothing was published"
            : `[nifra/web] live: the hub did not take the event; the first ${published} keys were published, the rest were not`,
        )
      }
    }
  }

  let inflight = 0
  let entering = 0

  const attach = (input: LiveAttachInput): LiveAttachment => {
    const loads = new WeakMap<Request, LoadState>()
    const app = input.app
    if (hubNamespace === undefined) registerSocket(app)

    function registerSocket(app: LiveAttachInput["app"]): void {
      publishers.add(weakPublisher(app, publishers))
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
    }

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
      const auth = await authority
      const match = input.matchRoute(path)
      const now = Date.now()
      const presented: OpenedGrant[] = []
      for (const token of body.grants) {
        const opened = await auth.ring.open(token, now)
        if (opened === undefined) continue
        const claims = opened.claims
        if (claims.sid !== body.sid || claims.frame !== body.frame) continue
        // A navigation presents the grant of the page it leaves: only its layouts can carry over, and
        // only where the layout itself would keep its data. A renewal is for the same page.
        if (claims.path !== path && body.mode === "renew") continue
        presented.push(opened)
      }
      // Read before any hook, middleware or loader runs: every owner loaded fresh is at least this new.
      const state = await auth.check(presented.map((opened) => opened.claims))
      const loadSeq = state.seq
      // With the log unreachable, revocations are unknown: nothing presented is honored.
      const grant = state.down
        ? undefined
        : presented.find((opened) => !state.revocations.grantRevoked(opened.claims))
      const requested =
        grant === undefined
          ? []
          : body.mode === "load"
            ? body.retain
            : authorize === undefined || grant.claims.r >= MAX_QUIET_RENEWALS
              ? []
              : Object.keys(grant.claims.owners)
      const layouts: number[] = []
      const holes: string[] = []
      let retainPage = false
      if (grant !== undefined && match !== null) {
        const claims = grant.claims
        for (const owner of requested) {
          const held = Object.hasOwn(claims.owners, owner) ? claims.owners[owner] : undefined
          if (held === undefined) continue
          // A key revoked since issuance is never kept or re-signed: its loader runs and decides again.
          if (held.k.some((key) => state.revocations.keyRevoked(key, claims))) continue
          if (owner.startsWith("L:")) {
            const index = match.layoutIds.indexOf(owner.slice(2))
            if (index !== -1 && !layouts.includes(index)) layouts.push(index)
          } else if (owner === `P:${match.routeId}` && claims.path === path) {
            retainPage = true
          } else if (claims.path === path) {
            const hole = holeOf(owner, match.routeId)
            if (hole !== undefined && !holes.includes(hole)) holes.push(hole)
          }
        }
      }
      const headers = internalHeaders(req.headers)
      if (grant !== undefined && layouts.length > 0) {
        // The page the grant was issued for: the retention rule compares each layout's params there
        // with the target's, exactly as for a router navigation.
        headers.set(RETAIN_HEADER, layouts.sort((a, b) => a - b).join(","))
        headers.set(NAV_FROM_HEADER, grant.claims.path)
      }
      if (holes.length > 0) headers.set(KEEP_HOLES_HEADER, holes.join(","))
      if (body.fill.length > 0) headers.set(HOLE_FILL_HEADER, body.fill.join(","))
      const target = new Request(new URL(path, req.url), {
        method: "GET",
        headers,
        signal: req.signal,
      })
      loads.set(
        target,
        new LoadState(
          auth.ring,
          state.down,
          body,
          path,
          loadSeq,
          grant,
          match?.routeId ?? "",
          retainPage,
        ),
      )
      return target
    }

    return {
      onRequest: (req) => {
        const pathname = pathnameOf(req.url)
        if (req.method === "POST" && pathname === loadPath) return admitLoad(req)
        if (hubNamespace !== undefined && req.method === "GET" && pathname === socketPath) {
          return forwardSocket(hubNamespace, req)
        }
        return undefined
      },
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
      private readonly ring: Keyring,
      /** No grant is issued: no socket would accept one, and revocations are unknown. */
      private readonly down: boolean,
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
      const ring = this.ring
      const subjects = await ring.subjectTags(this.subject)
      const pageRetained = input.retained.some((owner) => owner.startsWith("P:"))
      const bare: LiveEnvelope = pageRetained ? { subjects, page: "retained" } : { subjects }
      // No socket would accept a grant now, and revocations are unknown: the client polls.
      if (this.down || (core?.hub.down ?? false)) return bare
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
      // Each key to the owners holding it, in owner order.
      const owning = new Map<string, string[]>()
      for (const [name, owner] of Object.entries(owners)) {
        for (const key of owner.k) {
          const list = owning.get(key)
          if (list === undefined) owning.set(key, [name])
          else if (list.at(-1) !== name) list.push(name)
        }
      }
      const keys = [...owning.keys()]
      const salt = queryKeys ? querySalt() : undefined
      const tagOf = await tags
      const [wire, digested] = await Promise.all([
        Promise.all(keys.map((key) => tagOf(key, 0))),
        salt === undefined
          ? undefined
          : queryDigester(salt).then((digest) => Promise.all(keys.map(digest))),
      ])
      const tagMap: Record<string, string[]> = {}
      const digests: Record<string, string> = {}
      keys.forEach((key, at) => {
        const tag = wire[at] ?? ""
        tagMap[tag] = owning.get(key) ?? []
        const digest = digested?.[at]
        if (digest !== undefined) digests[tag] = digest
      })
      const envelope: LiveEnvelope = { ...bare, grant, tags: tagMap, ttl }
      if (salt !== undefined) {
        return {
          ...envelope,
          query: production ? { salt, keys: digests } : { salt, keys: digests, dev: true },
        }
      }
      return production ? envelope : { ...envelope, query: { dev: true } }
    }
  }

  const checkKey = (key: unknown, method: string): string => {
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      throw new TypeError(`[nifra/web] live.${method} takes keys in the ctx.live() charset`)
    }
    return key
  }

  const clientEntry: { path?: string; loadPath?: string } = {}
  if (socketPath !== DEFAULT_SOCKET_PATH) clientEntry.path = socketPath
  if (loadPath !== DEFAULT_LOAD_PATH) clientEntry.loadPath = loadPath

  return {
    clientEntry: Object.freeze(clientEntry),
    ready: authority.then(() => undefined),
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

/**
 * `app.publish`, holding the app weakly: a dev server builds a new app on every edit, and a discarded
 * one must not stay reachable, nor keep being published to, through the runtime. Built out here so
 * the closure's scope holds nothing else of the app.
 */
function weakPublisher(
  app: { publish(topic: string, frame: string): unknown },
  publishers: Set<(topic: string, frame: string) => void>,
): (topic: string, frame: string) => void {
  const held = new WeakRef(app)
  const publisher = (topic: string, frame: string): void => {
    const attached = held.deref()
    if (attached === undefined) publishers.delete(publisher)
    else attached.publish(topic, frame)
  }
  return publisher
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

const noSecret = (secret: LiveOptions["secret"]): boolean =>
  secret === undefined || (Array.isArray(secret) && secret.length === 0) || secret === ""

function secretsOf(secret: LiveOptions["secret"]): readonly unknown[] {
  if (secret !== undefined && !noSecret(secret))
    return typeof secret === "string" ? [secret] : secret
  if (isProduction()) {
    throw new TypeError(
      "[nifra/web] live: `secret` is required in production. Generate one with: openssl rand -base64 32",
    )
  }
  return [toBase64Url(crypto.getRandomValues(new Uint8Array(32)))]
}

/**
 * An environment this cannot read counts as production, so a secret is required: Deno throws on
 * `process.env` without `--allow-env`, and a runtime with no `process` says nothing either way.
 */
function isProduction(): boolean {
  try {
    return typeof process === "undefined" || process.env?.NODE_ENV === "production"
  } catch {
    return true
  }
}

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

/** The hole a `B:<hole>:<routeId>` owner of route `routeId` names. */
function holeOf(owner: string, routeId: string): string | undefined {
  const suffix = `:${routeId}`
  if (!owner.startsWith("B:") || !owner.endsWith(suffix)) return undefined
  const hole = owner.slice(2, owner.length - suffix.length)
  return hole === "" || hole.includes(":") || hole.includes(",") ? undefined : hole
}

function parseBody(text: string): LoadBody | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const { path, sid, frame, mode, retain = [], grants = [], fill = [] } = value
  if (typeof path !== "string" || typeof sid !== "string" || !SID_PATTERN.test(sid))
    return undefined
  // Only the page frame is served; boundary frames arrive with the client's frame support.
  if (frame !== PAGE_FRAME || (mode !== "load" && mode !== "renew")) return undefined
  if (!isStringList(retain, MAX_RETAIN, MAX_OWNER_CHARS)) return undefined
  if (!isStringList(grants, MAX_GRANTS, MAX_GRANT_CHARS)) return undefined
  if (!isStringList(fill, MAX_HOSTS, MAX_HOST_CHARS) || !fill.every((name) => HOST.test(name)))
    return undefined
  return { path, sid, frame, mode, retain, grants, fill }
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
