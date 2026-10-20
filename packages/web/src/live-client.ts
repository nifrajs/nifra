/**
 * Live refresh in the browser. The client entry of an app with `live` builds its router with this
 * module's `fetchData`, so every route load is a live load that returns a grant beside its data, and
 * attaches the router once it is mounted. One WebSocket per tab watches the grants of what is on
 * screen - the page, and the target an intercept boundary holds - and a change to a key either read
 * reloads it, keeping every owner whose keys did not change.
 *
 * A frame whose load returned no grant, and every frame while the socket is down, is polled instead.
 */
import { appUrl } from "./internal/route-path.ts"
import {
  type ClientRouter,
  DATA_HEADER,
  type FetchRouteData,
  isRouteDataEnvelope,
  NAV_FROM_HEADER,
  RETAIN_HEADER,
  routeDataOf,
} from "./router.ts"

export interface LiveClientOptions {
  /** The live socket, as `live({ path })` serves it. Default `/_nifra/live`. */
  readonly path?: string
  /** The live load endpoint, as `live({ loadPath })` serves it. Default `/_nifra/live/load`. */
  readonly loadPath?: string
  /**
   * Sends every live load. Give one that adds an `Authorization` header when the app authenticates
   * that way; cookies are sent by default.
   */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** Route id to its layout ids, outermost first. The generated client entry passes its own table. */
  readonly layoutIdsOf?: Readonly<Record<string, readonly string[]>>
}

export interface LiveClient {
  /** Pass as `createClientRouter({ fetchData })`: every route load goes through the live load endpoint. */
  readonly fetchData: FetchRouteData
  /** Keep what `router` shows fresh. Returns a function that stops and closes the socket. */
  attach(router: ClientRouter): () => void
}

const HEARTBEAT = "p"
const HEARTBEAT_MS = 30_000
const RENEW_BEFORE_MS = 60_000
const RENEW_JITTER_MS = 30_000
const POLL_MS = 30_000
const MAX_POLL_MS = 300_000
const FOCUS_RELOAD_MS = 5_000
const RETRIES = 3
const RETRY_MS = 1_000
const MAX_RECONNECT_MS = 30_000
/** Failed connects in a row before frames poll instead of waiting for the socket. */
const CONNECTS_BEFORE_POLLING = 3
const MAX_SPREAD_MS = 5_000
const PAGE = "page"
const SID = /^[0-9a-f]{32}$/

/** What a live load handed the router, carried in its state beside the data it loaded. */
interface Loaded {
  readonly routeId: string
  /** The socket id the grant is bound to. */
  readonly sid: string
  readonly grant: string | undefined
  /** Wire tag to the owners in this load that watch its key. */
  readonly tags: ReadonlyMap<string, readonly string[]>
  /** Client clock, in ms. */
  readonly expiresAt: number
  readonly ttlMs: number
}

/** A live load the client itself asked the router for, read back by `fetchData` in the same call. */
interface Intent {
  readonly path: string
  readonly mode: "load" | "renew"
  readonly held: Loaded | undefined
  readonly retain: readonly string[]
  /** What is on screen now: the copies a retained owner keeps. */
  readonly data: unknown
  readonly layoutData: readonly unknown[] | undefined
}

/** A load on screen: the page, or the target an intercept boundary holds. */
interface Frame {
  /** `"page"`, or the boundary's name. */
  readonly slot: string
  path: string
  readonly routeId: string
  readonly loaded: Loaded | undefined
  readonly shownAt: number
  /** Owners known to have changed since their data loaded. */
  dirty: Set<string>
  /** Every owner reloads: there is no grant to keep any of them by. */
  whole: boolean
  /** The watch generation that installed this frame's grant, once `ready` confirmed it. */
  installed: boolean
  /** Set while a watch carrying this frame's grant waits for its `ready`. */
  pending: number | undefined
  loading: boolean
  failures: number
  retryAt: number
  renewAt: number
  pollAt: number
}

export function liveClient(options: LiveClientOptions = {}): LiveClient {
  const socketPath = options.path ?? "/_nifra/live"
  const loadPath = options.loadPath ?? "/_nifra/live/load"
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))
  const layoutIdsOf = options.layoutIdsOf ?? {}
  // Loads made with no socket are bound to an id no socket has, so their grants are never watched.
  const localSid = randomSid()
  let router: ClientRouter | undefined
  let sid: string | undefined
  let subject: string | undefined
  let switched = false
  let intent: Intent | undefined
  // The handles this client put in router state: anything else there is not a live load.
  const issued = new WeakMap<object, Loaded>()
  const loadedOf = (value: unknown): Loaded | undefined =>
    typeof value === "object" && value !== null ? issued.get(value) : undefined
  let frames: Frame[] = []
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // A frame with no usable grant gets one load for one under each socket; after that it polls.
  const tried = new Set<string>()
  const pollFailures = new Map<string, number>()
  let ws: WebSocket | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let connectFailures = 0
  let gen = 0
  let sent:
    | { readonly gen: number; readonly frames: readonly Frame[]; readonly grants: string }
    | undefined
  // Set by an account switch: the next socket's `welcome` reloads everything under its id.
  let clearOnWelcome = false

  const ownersOf = (routeId: string): string[] => [
    ...(layoutIdsOf[routeId] ?? []).map((id) => `L:${id}`),
    `P:${routeId}`,
  ]

  /** A plain data GET: the router's own transport, for a navigation the live endpoint turned away. */
  const plainLoad: FetchRouteData = async (path, _match, signal, navigation) => {
    const headers = new Headers({ [DATA_HEADER]: "1" })
    if (navigation !== undefined && navigation.retain.length > 0) {
      headers.set(RETAIN_HEADER, navigation.retain.join(","))
      headers.set(NAV_FROM_HEADER, navigation.from)
    }
    return routeDataOf(await send(appUrl(path), { headers, signal: signal ?? null }), path, signal)
  }

  const fetchData: FetchRouteData = async (path, match, signal, navigation) => {
    // Read before anything awaits: the client's own reload calls the router, which calls here at once.
    const own = intent?.path === path ? intent : undefined
    if (own !== undefined) intent = undefined
    const bound = sid ?? localSid
    let held = own?.held
    const retain: string[] = own === undefined ? [] : [...own.retain]
    if (own === undefined && navigation !== undefined && navigation.retain.length > 0) {
      // A navigation offering its layouts presents the page it leaves: the server keeps those a
      // router navigation would, and none whose keys changed.
      const page = frames.find((frame) => frame.slot === PAGE)
      held = page?.loaded
      const from = layoutIdsOf[router?.snapshot().routeId ?? ""] ?? []
      for (const index of navigation.retain) {
        const id = from[index]
        if (id !== undefined && page?.dirty.has(`L:${id}`) === false) retain.push(`L:${id}`)
      }
    }
    const grant = held?.grant !== undefined && held.sid === bound ? held.grant : undefined
    const res = await send(appUrl(loadPath), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path,
        sid: bound,
        frame: PAGE,
        mode: own?.mode ?? "load",
        retain: grant === undefined ? [] : retain,
        grants: grant === undefined ? [] : [grant],
      }),
      signal: signal ?? null,
    })
    if (res.status === 503) {
      await res.body?.cancel()
      // Admission bounds reloads; a navigation the user asked for is not held behind it.
      if (own === undefined) return plainLoad(path, match, signal, navigation)
      throw new Error(`[nifra/web] live load busy: ${path}`)
    }
    const payload = await routeDataOf(res, path, signal)
    if (!isRouteDataEnvelope(payload)) return payload
    const live = envelopeOf(payload.live)
    if (live === undefined) return { ...payload, live: undefined }
    if (subject !== undefined && live.subject !== subject) switched = true
    subject = live.subject
    const loaded: Loaded = {
      routeId: match.routeId,
      sid: bound,
      grant: live.grant,
      tags: new Map(Object.entries(live.tags ?? {})),
      expiresAt: live.ttl === undefined ? Number.POSITIVE_INFINITY : Date.now() + live.ttl * 1000,
      ttlMs: live.ttl === undefined ? Number.POSITIVE_INFINITY : live.ttl * 1000,
    }
    issued.set(loaded, loaded)
    if (own === undefined || grant === undefined) return { ...payload, live: loaded }
    // The server kept what was offered and is still current: show the copies already on screen.
    const kept = new Set(payload.retained ?? [])
    const shown = own.layoutData
    return {
      ...payload,
      data: live.page === "retained" ? own.data : payload.data,
      layoutData: payload.layoutData?.map((value, index) =>
        kept.has(index) && shown !== undefined && index < shown.length ? shown[index] : value,
      ),
      live: loaded,
    }
  }

  // --- On screen -----------------------------------------------------------------------------------

  const watchable = (frame: Frame): boolean =>
    frame.loaded?.grant !== undefined && frame.loaded.sid === sid
  const hidden = (): boolean => globalThis.document?.visibilityState === "hidden"
  const polling = (): boolean => sid === undefined && connectFailures >= CONNECTS_BEFORE_POLLING

  const frameFor = (
    slot: string,
    path: string,
    routeId: string,
    loaded: Loaded | undefined,
    now: number,
  ): Frame => {
    const same = frames.find(
      (frame) =>
        frame.slot === slot &&
        frame.loaded === loaded &&
        (loaded !== undefined || frame.path === path),
    )
    if (same !== undefined) {
      // A client-only search change keeps the load and moves its URL.
      same.path = path
      return same
    }
    return {
      slot,
      path,
      routeId: loaded?.routeId ?? routeId,
      loaded,
      shownAt: now,
      dirty: new Set(),
      whole: false,
      installed: false,
      pending: undefined,
      loading: false,
      failures: 0,
      retryAt: 0,
      // A minute early, less up to 30 s of jitter; a short grant renews a third of its life early.
      renewAt:
        loaded === undefined
          ? Number.POSITIVE_INFINITY
          : loaded.expiresAt -
            Math.min(RENEW_BEFORE_MS, loaded.ttlMs / 3) -
            Math.random() * Math.min(RENEW_JITTER_MS, loaded.ttlMs / 6),
      pollAt: now + jittered(POLL_MS * 2 ** Math.min(pollFailures.get(path) ?? 0, 4), MAX_POLL_MS),
    }
  }

  const reconcile = (): void => {
    const current = router
    if (stopped || current === undefined) return
    const state = current.snapshot()
    const now = Date.now()
    const next = [
      frameFor(
        PAGE,
        state.intercepted?.pagePath ?? state.path,
        state.routeId,
        loadedOf(state.live),
        now,
      ),
    ]
    const intercepted = state.intercepted
    const held = intercepted === undefined ? undefined : state.boundaries?.[intercepted.boundary]
    if (intercepted !== undefined && held?.status === "ready") {
      next.push(
        frameFor(
          intercepted.boundary,
          state.path,
          current.match(state.path)?.routeId ?? "",
          loadedOf(held.live),
          now,
        ),
      )
    }
    frames = next
    for (const frame of frames) {
      // No grant to watch by yet: load one once the socket can take it.
      if (!watchable(frame) && sid !== undefined && !tried.has(`${sid}\n${frame.path}`)) {
        tried.add(`${sid}\n${frame.path}`)
        frame.whole = true
      }
    }
    if (switched && !state.pending) {
      // Another viewer: nothing kept, cached or watched for the last one survives.
      switched = false
      restart()
      return
    }
    sendWatch()
    run()
  }

  const run = (): void => {
    const current = router
    if (stopped || current === undefined || hidden() || current.snapshot().pending) return
    const now = Date.now()
    for (const frame of frames) {
      if (frame.loading || frame.retryAt > now) continue
      const live = watchable(frame)
      if (frame.whole || frame.dirty.size > 0) reload(frame, "load")
      else if (live && frame.pending === undefined && now >= frame.renewAt) reload(frame, "renew")
      else if (!live && (polling() || frame.loaded?.grant === undefined) && now >= frame.pollAt)
        reload(frame, "load")
      // One load at a time: the router runs it, and its next state runs this again.
      if (current.snapshot().pending) break
    }
    arm()
  }

  /** Wake for the earliest renewal, poll or retry due. */
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (stopped) return
    let at = Number.POSITIVE_INFINITY
    for (const frame of frames) {
      if (frame.loading) continue
      if (frame.retryAt > 0 && frame.retryAt < Number.POSITIVE_INFINITY)
        at = Math.min(at, frame.retryAt)
      if (watchable(frame)) at = Math.min(at, frame.renewAt)
      else if (polling() || frame.loaded?.grant === undefined) at = Math.min(at, frame.pollAt)
    }
    if (at === Number.POSITIVE_INFINITY) return
    timer = setTimeout(run, Math.max(0, at - Date.now()))
  }

  const reload = (frame: Frame, mode: "load" | "renew"): void => {
    const current = router
    if (current === undefined) return
    const state = current.snapshot()
    const page = frame.slot === PAGE
    const held = frame.whole ? undefined : frame.loaded
    intent = {
      path: frame.path,
      mode: held === undefined ? "load" : mode,
      held,
      retain:
        held === undefined || mode === "renew"
          ? []
          : ownersOf(frame.routeId).filter((owner) => !frame.dirty.has(owner)),
      data: page ? state.data : state.boundaries?.[frame.slot]?.data,
      layoutData: page ? state.layoutData : undefined,
    }
    frame.loading = true
    frame.whole = false
    let running: Promise<void>
    try {
      running = current.invalidate([frame.path])
    } finally {
      intent = undefined
    }
    const settle = (ok: boolean): void => {
      frame.loading = false
      // Applied, the load is a new frame; still on screen, nothing was applied.
      if (ok && !frames.includes(frame)) {
        pollFailures.delete(frame.path)
        return
      }
      if (!ok && !watchable(frame))
        pollFailures.set(frame.path, (pollFailures.get(frame.path) ?? 0) + 1)
      frame.failures++
      // Three tries, then wait for a change, a visibility change or the renewal.
      frame.retryAt =
        frame.failures > RETRIES
          ? Number.POSITIVE_INFINITY
          : Date.now() + jittered(RETRY_MS * 2 ** (frame.failures - 1), MAX_RECONNECT_MS)
      if (!watchable(frame))
        frame.pollAt =
          Date.now() + jittered(POLL_MS * 2 ** Math.min(frame.failures, 4), MAX_POLL_MS)
      run()
    }
    running.then(
      () => settle(true),
      () => settle(false),
    )
  }

  // --- The socket ----------------------------------------------------------------------------------

  const sendWatch = (): void => {
    const socket = ws
    if (socket === undefined || sid === undefined || socket.readyState !== 1) return
    const watched = frames.filter(watchable)
    const grants = watched.map((frame) => frame.loaded?.grant ?? "")
    const key = grants.join("\n")
    if (sent === undefined && grants.length === 0) return
    if (sent?.grants === key) {
      sent = { gen: sent.gen, frames: watched, grants: key }
      return
    }
    gen++
    sent = { gen, frames: watched, grants: key }
    for (const frame of watched) if (!frame.installed) frame.pending = gen
    socket.send(JSON.stringify({ t: "watch", gen, grants }))
  }

  const onReady = (value: Record<string, unknown>): void => {
    if (sent === undefined || value.gen !== sent.gen || !Array.isArray(value.stale)) return
    const stale: unknown[] = value.stale
    sent.frames.forEach((frame, index) => {
      const changed = stale[index]
      frame.pending = undefined
      frame.installed = true
      // Every change since each owner's data loaded is in this list; nothing before `ready` counts.
      frame.dirty = new Set(
        Array.isArray(changed) ? changed.filter((owner) => typeof owner === "string") : [],
      )
    })
    run()
  }

  const onChanged = (value: Record<string, unknown>): void => {
    const { tag, spread } = value
    if (typeof tag !== "string") return
    const delay =
      typeof spread === "number" && spread > 0 ? Math.random() * Math.min(spread, MAX_SPREAD_MS) : 0
    for (const frame of frames) {
      const owners = frame.loaded?.tags.get(tag)
      // A tag this frame does not hold is another load's; a pending frame's `ready` settles it.
      if (owners === undefined || frame.pending !== undefined || !watchable(frame)) continue
      const mark = (): void => {
        if (!frames.includes(frame) || frame.pending !== undefined) return
        for (const owner of owners) frame.dirty.add(owner)
        frame.failures = 0
        frame.retryAt = 0
        run()
      }
      if (delay === 0) mark()
      else setTimeout(mark, delay)
    }
  }

  const connect = (): void => {
    reconnect = undefined
    if (stopped) return
    const url = new URL(appUrl(socketPath), globalThis.location?.href ?? "http://localhost/")
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    let socket: WebSocket
    try {
      socket = new WebSocket(url.href)
    } catch {
      closed(1006, false)
      return
    }
    ws = socket
    let welcomed = false
    socket.onmessage = (event: MessageEvent) => {
      if (ws !== socket || typeof event.data !== "string" || event.data === HEARTBEAT) return
      let value: unknown
      try {
        value = JSON.parse(event.data)
      } catch {
        return
      }
      if (!isRecord(value)) return
      if (value.t === "welcome" && typeof value.sid === "string" && SID.test(value.sid)) {
        welcomed = true
        connectFailures = 0
        sid = value.sid
        heartbeat = setInterval(() => {
          if (socket.readyState === 1) socket.send(HEARTBEAT)
        }, HEARTBEAT_MS)
        if (clearOnWelcome) {
          clearOnWelcome = false
          router?.invalidate().catch(() => {})
        }
        reconcile()
      } else if (value.t === "ready") onReady(value)
      else if (value.t === "changed") onChanged(value)
    }
    socket.onclose = (event: CloseEvent) => {
      if (ws !== socket) return
      closed(event.code, welcomed)
    }
  }

  const closed = (code: number, welcomed: boolean): void => {
    ws = undefined
    sid = undefined
    sent = undefined
    if (heartbeat !== undefined) clearInterval(heartbeat)
    heartbeat = undefined
    for (const frame of frames) {
      frame.installed = false
      frame.pending = undefined
    }
    if (stopped) return
    if (!welcomed) connectFailures++
    // A full server asks every client to wait; a protocol refusal is not retried at once.
    const base = code === 1013 || code === 1008 ? 5_000 : RETRY_MS
    reconnect = setTimeout(
      connect,
      jittered(base * 2 ** Math.min(connectFailures, 5), MAX_RECONNECT_MS),
    )
    run()
  }

  /** A new viewer: a new socket, every cache cleared, and what is on screen loaded under it. */
  const restart = (): void => {
    tried.clear()
    const socket = ws
    if (socket === undefined) {
      router?.invalidate().catch(() => {})
      return
    }
    ws = undefined
    socket.close(1000)
    closed(1000, true)
    if (reconnect !== undefined) clearTimeout(reconnect)
    clearOnWelcome = true
    connect()
  }

  const onVisible = (): void => {
    if (hidden()) return
    for (const frame of frames) {
      frame.failures = 0
      frame.retryAt = 0
    }
    run()
  }
  const onFocus = (): void => {
    const now = Date.now()
    for (const frame of frames) {
      if (!watchable(frame) && now - frame.shownAt > FOCUS_RELOAD_MS) frame.pollAt = now
    }
    run()
  }

  return {
    fetchData,
    attach(target) {
      router = target
      stopped = false
      const unsubscribe = target.subscribe(reconcile)
      globalThis.document?.addEventListener("visibilitychange", onVisible)
      globalThis.addEventListener?.("focus", onFocus)
      connect()
      reconcile()
      return () => {
        stopped = true
        unsubscribe()
        globalThis.document?.removeEventListener("visibilitychange", onVisible)
        globalThis.removeEventListener?.("focus", onFocus)
        if (timer !== undefined) clearTimeout(timer)
        if (reconnect !== undefined) clearTimeout(reconnect)
        const socket = ws
        ws = undefined
        socket?.close(1000)
        closed(1000, true)
        router = undefined
      }
    },
  }
}

interface ServerEnvelope {
  readonly subject: string
  readonly grant?: string
  readonly tags?: Readonly<Record<string, readonly string[]>>
  readonly page?: "retained"
  readonly ttl?: number
}

/** The server's live envelope, or `undefined` for anything else in its place. */
function envelopeOf(value: unknown): ServerEnvelope | undefined {
  if (!isRecord(value)) return undefined
  const { subject, grant, tags, page, ttl } = value
  if (typeof subject !== "string") return undefined
  if (grant !== undefined && typeof grant !== "string") return undefined
  if (ttl !== undefined && (typeof ttl !== "number" || !(ttl > 0))) return undefined
  if (page !== undefined && page !== "retained") return undefined
  const owned: Record<string, readonly string[]> = {}
  if (tags !== undefined) {
    if (!isRecord(tags)) return undefined
    for (const [tag, owners] of Object.entries(tags)) {
      if (!Array.isArray(owners)) return undefined
      const names: string[] = []
      for (const owner of owners) {
        if (typeof owner !== "string") return undefined
        names.push(owner)
      }
      owned[tag] = names
    }
  }
  const envelope: {
    subject: string
    tags: Record<string, readonly string[]>
    grant?: string
    page?: "retained"
    ttl?: number
  } = { subject, tags: owned }
  if (typeof grant === "string") envelope.grant = grant
  if (page === "retained") envelope.page = page
  if (typeof ttl === "number") envelope.ttl = ttl
  return envelope
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** `ms` spread over +/-20%, capped. */
const jittered = (ms: number, max: number): number =>
  Math.min(max, ms * (0.8 + Math.random() * 0.4))

function randomSid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}
