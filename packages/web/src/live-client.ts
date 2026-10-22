/**
 * Live refresh in the browser. The client entry of an app with `live` builds its router with this
 * module's `fetchData`, so every route load is a live load that returns a grant beside its data, and
 * attaches the router once it is mounted. One WebSocket per tab watches the grants of what is on
 * screen - the page, and the target an intercept boundary holds - and a change to a key either read
 * reloads it, keeping every owner whose keys did not change.
 *
 * A frame whose load returned no grant, and every frame while the socket is down, is polled instead.
 *
 * Query hooks that name live keys refetch on the same changes: each load carries a salted digest of
 * every key it grants, and the client matches the keys the page's queries name against them.
 */

import type { BoundaryState, BoundaryStates } from "./boundary.ts"
import {
  advanceLiveTick,
  clearQueryClients,
  type LiveQuery,
  liveQueries,
  registeredAt,
  watchLiveQueries,
} from "./internal/live-queries.ts"
import { queryDigester } from "./internal/query-digest.ts"
import { appUrl } from "./internal/route-path.ts"
import {
  type ClientRouter,
  DATA_HEADER,
  type FetchRouteData,
  HOLE_FILL_HEADER,
  isRouteDataEnvelope,
  NAV_FROM_HEADER,
  RETAIN_HEADER,
  type RouteDataEnvelope,
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
const RETRY_MS = 1_000
const MAX_RECONNECT_MS = 30_000
/** Failed connects in a row before frames poll instead of waiting for the socket. */
const CONNECTS_BEFORE_POLLING = 3
const MAX_SPREAD_MS = 5_000
const PAGE = "page"
const SID = /^[0-9a-f]{32}$/

/**
 * What a live load handed the router, carried in its state beside the data it loaded. A load whose
 * holes were still loading gets its grant after them: until then `trailing` is set and the fields the
 * envelope fills are empty.
 */
interface Loaded {
  readonly routeId: string
  /** The socket id the grant is bound to. */
  readonly sid: string
  grant: string | undefined
  /** Wire tag to the owners in this load that watch its key. */
  tags: ReadonlyMap<string, readonly string[]>
  /** Client clock, in ms. */
  expiresAt: number
  ttlMs: number
  /** The live tick its response arrived at. */
  readonly tick: number
  query: QueryKeys | undefined
  trailing: boolean
}

/** What a load tells query hooks about the keys it grants. */
interface QueryKeys {
  /** Absent when the app has `queryKeys` off. */
  readonly salt: string | undefined
  /** Digest of a granted key under `salt` to its wire tag. */
  readonly tags: ReadonlyMap<string, string>
  readonly dev: boolean
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
  readonly boundaries: BoundaryStates | undefined
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
  // The last load's viewer tags: one per secret the server lists.
  let subjects: readonly string[] | undefined
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
  // The spread the last `welcome` asked for: the reloads a new socket id needs go out over it.
  let welcomeSpread = 0
  let gen = 0
  let sent:
    | { readonly gen: number; readonly frames: readonly Frame[]; readonly grants: string }
    | undefined
  // Set by an account switch: the next socket's `welcome` reloads everything under its id.
  let clearOnWelcome = false
  // Query hooks: wire tag to the queries whose keys it carries, from the last match.
  let matched = new Map<string, Set<LiveQuery>>()
  // Tag to the live tick of the load from which an installed watch has held it without a break; a
  // query that asked for its data before that tick may have missed a change.
  const heldSince = new Map<string, number>()
  let matching = 0
  let matchScheduled = false
  let matchedLoads: readonly (Loaded | undefined)[] = []
  let changedWhileMatching: Set<string> | undefined
  // Salt to its digester and the digests it made: a salt lives as long as its load is on screen.
  const digesters = new Map<
    string,
    {
      readonly sign: Promise<(key: string) => Promise<string>>
      readonly made: Map<string, Promise<string>>
    }
  >()
  const warned = new Set<string>()
  let unwatchQueries: (() => void) | undefined

  /** The owners a load of `routeId` may keep: its layouts, its page and the holes `shown` holds. */
  const ownersOf = (routeId: string, shown: BoundaryStates | undefined): string[] => {
    const owners = [...(layoutIdsOf[routeId] ?? []).map((id) => `L:${id}`), `P:${routeId}`]
    for (const state of Object.values(shown ?? {}))
      if (state.mode === "dynamic" || state.mode === "shared")
        owners.push(`B:${state.name}:${routeId}`)
    return owners
  }

  /** A load's envelope written into its handle; a new viewer clears what the last one cached. */
  const settleLoaded = (loaded: Loaded, live: ServerEnvelope | undefined): void => {
    loaded.trailing = false
    if (live === undefined) return
    const last = subjects
    if (last !== undefined && !live.subjects.some((tag) => last.includes(tag))) {
      switched = true
      // Nothing a query loaded for the last viewer may show to this one.
      clearQueryClients()
    }
    subjects = live.subjects
    loaded.grant = live.grant
    loaded.tags = new Map(Object.entries(live.tags ?? {}))
    loaded.expiresAt =
      live.ttl === undefined ? Number.POSITIVE_INFINITY : Date.now() + live.ttl * 1000
    loaded.ttlMs = live.ttl === undefined ? Number.POSITIVE_INFINITY : live.ttl * 1000
    loaded.query = live.query
  }

  /** A plain data GET: the router's own transport, for a navigation the live endpoint turned away. */
  const plainLoad: FetchRouteData = async (path, _match, signal, navigation, purpose) => {
    const headers = new Headers({ [DATA_HEADER]: "1" })
    if (purpose === "refill") headers.set(HOLE_FILL_HEADER, "1")
    if (navigation !== undefined && navigation.retain.length > 0) {
      headers.set(RETAIN_HEADER, navigation.retain.join(","))
      headers.set(NAV_FROM_HEADER, navigation.from)
    }
    return routeDataOf(await send(appUrl(path), { headers, signal: signal ?? null }), path, signal)
  }

  const fetchData: FetchRouteData = async (path, match, signal, navigation, purpose) => {
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
        fill: purpose === "refill" || undefined,
      }),
      signal: signal ?? null,
    })
    if (res.status === 503) {
      await res.body?.cancel()
      // Admission bounds reloads; a navigation the user asked for is not held behind it.
      if (own === undefined) return plainLoad(path, match, signal, navigation, purpose)
      throw new Error(`[nifra/web] live load busy: ${path}`)
    }
    const payload = await routeDataOf(res, path, signal)
    if (!isRouteDataEnvelope(payload)) return payload
    const kept = own === undefined || grant === undefined ? payload : keptBy(payload, own)
    const loaded: Loaded = {
      routeId: match.routeId,
      sid: bound,
      grant: undefined,
      tags: new Map(),
      expiresAt: Number.POSITIVE_INFINITY,
      ttlMs: Number.POSITIVE_INFINITY,
      tick: advanceLiveTick(),
      query: undefined,
      trailing: false,
    }
    const trailing = deferredOf(payload.live)
    if (trailing !== undefined) {
      // The grant follows the holes: the frame waits for it, then watches or polls as any other.
      loaded.trailing = true
      issued.set(loaded, loaded)
      trailing.then(
        (value) => granted(loaded, envelopeOf(value)),
        () => granted(loaded, undefined),
      )
      return { ...kept, live: loaded }
    }
    const live = envelopeOf(payload.live)
    if (live === undefined) return { ...kept, live: undefined }
    settleLoaded(loaded, live)
    issued.set(loaded, loaded)
    // The page loader did not run: show the copy already on screen.
    if (own !== undefined && grant !== undefined && live.page === "retained")
      return { ...kept, data: own.data, live: loaded }
    return { ...kept, live: loaded }
  }

  /** What the server kept of what was offered, and is still current: the copies already on screen. */
  const keptBy = (payload: RouteDataEnvelope, own: Intent): RouteDataEnvelope => {
    const retained = new Set(payload.retained ?? [])
    const shown = own.layoutData
    let boundaries = payload.boundaries
    for (const [name, state] of Object.entries(payload.boundaries ?? {})) {
      const held = own.boundaries?.[name]
      if (state.kept !== true || held === undefined) continue
      boundaries = { ...boundaries, [name]: held satisfies BoundaryState }
    }
    const layoutData = payload.layoutData?.map((value, index) =>
      retained.has(index) && shown !== undefined && index < shown.length ? shown[index] : value,
    )
    return {
      ...payload,
      ...(layoutData === undefined ? {} : { layoutData }),
      ...(boundaries === undefined ? {} : { boundaries }),
    }
  }

  /** A trailing grant arrived, or will not: the frame holding `loaded` watches or polls from now. */
  const granted = (loaded: Loaded, live: ServerEnvelope | undefined): void => {
    settleLoaded(loaded, live)
    for (const frame of frames) if (frame.loaded === loaded) frame.renewAt = renewAtOf(loaded)
    reconcile()
  }

  // --- On screen -----------------------------------------------------------------------------------

  const watchable = (frame: Frame): boolean =>
    frame.loaded?.grant !== undefined && frame.loaded.sid === sid
  /** A socket serves a frame holding a tag, or one still to get a grant; a page with neither needs none. */
  const wantsSocket = (): boolean =>
    frames.length === 0 ||
    frames.some((frame) => frame.loaded?.grant === undefined || frame.loaded.tags.size > 0)
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
      renewAt: loaded === undefined ? Number.POSITIVE_INFINITY : renewAtOf(loaded),
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
    // Nothing to watch let the last socket go; a frame that now holds a tag opens the next.
    if (ws === undefined && reconnect === undefined && wantsSocket()) connect()
    for (const frame of frames) {
      // No grant to watch by yet: load one once the socket can take it. A trailing one is on its way.
      if (
        !watchable(frame) &&
        frame.loaded?.trailing !== true &&
        sid !== undefined &&
        !tried.has(`${sid}\n${frame.path}`)
      ) {
        tried.add(`${sid}\n${frame.path}`)
        frame.whole = true
        // A new socket is a new chance: no backoff carries over, only the spread it was given.
        frame.failures = 0
        frame.retryAt = welcomeSpread > 0 ? now + Math.random() * welcomeSpread : 0
      }
    }
    welcomeSpread = 0
    if (switched && !state.pending) {
      // Another viewer: nothing kept, cached or watched for the last one survives.
      switched = false
      restart()
      return
    }
    const loads = frames.map((frame) => frame.loaded)
    if (loads.length !== matchedLoads.length || loads.some((l, i) => l !== matchedLoads[i])) {
      matchedLoads = loads
      scheduleMatch()
    }
    sendWatch()
    run()
  }

  const run = (): void => {
    const current = router
    if (stopped || current === undefined || hidden() || current.snapshot().pending) return
    const now = Date.now()
    for (const frame of frames) {
      if (frame.loading || wakeOf(frame) > now) continue
      if (frame.whole || frame.dirty.size > 0) reload(frame, "load")
      else if (watchable(frame)) reload(frame, "renew")
      else reload(frame, "load", true)
      // One load at a time: the router runs it, and its next state runs this again.
      if (current.snapshot().pending) break
    }
    arm()
  }

  /**
   * When `run` loads this frame next; infinite when only an event can make it due. One rule for both
   * `run` and `arm`: a deadline `run` would skip must never be armed, or the timer spins until it can.
   */
  const wakeOf = (frame: Frame): number => {
    let due: number
    if (frame.whole || frame.dirty.size > 0) due = 0
    // Its grant trails the holes still loading; it arrives with or without one, and runs this again.
    else if (frame.loaded?.trailing === true) due = Number.POSITIVE_INFINITY
    // A renewal waits for the pending watch's `ready`, which runs this again.
    else if (watchable(frame))
      due = frame.pending === undefined ? frame.renewAt : Number.POSITIVE_INFINITY
    else if (polling() || frame.loaded?.grant === undefined) due = frame.pollAt
    else due = Number.POSITIVE_INFINITY
    return Math.max(frame.retryAt, due)
  }

  /** Wake for the earliest frame due. */
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (stopped) return
    let at = Number.POSITIVE_INFINITY
    for (const frame of frames) if (!frame.loading) at = Math.min(at, wakeOf(frame))
    if (at === Number.POSITIVE_INFINITY) return
    timer = setTimeout(run, Math.max(0, at - Date.now()))
  }

  /** `polled`: no change notice can reach this frame, so its queries refetch with it. */
  const reload = (frame: Frame, mode: "load" | "renew", polled = false): void => {
    const current = router
    if (current === undefined) return
    const state = current.snapshot()
    const page = frame.slot === PAGE
    const whole = frame.whole
    const held = whole ? undefined : frame.loaded
    intent = {
      path: frame.path,
      mode: held === undefined ? "load" : mode,
      held,
      retain:
        held === undefined || mode === "renew"
          ? []
          : ownersOf(frame.routeId, page ? state.boundaries : undefined).filter(
              (owner) => !frame.dirty.has(owner),
            ),
      data: page ? state.data : state.boundaries?.[frame.slot]?.data,
      layoutData: page ? state.layoutData : undefined,
      boundaries: page ? state.boundaries : undefined,
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
        if (polled) for (const query of liveQueries()) query.refresh()
        return
      }
      if (!ok && !watchable(frame))
        pollFailures.set(frame.path, (pollFailures.get(frame.path) ?? 0) + 1)
      // Still no grant to keep an owner by: the retry loads the frame whole again.
      if (whole) frame.whole = true
      frame.failures++
      // Backs off to five minutes, never further: a frame that gives up shows stale data for good.
      // A change, a visibility change or a new socket tries again at once.
      frame.retryAt =
        Date.now() + jittered(RETRY_MS * 2 ** Math.min(frame.failures - 1, 9), MAX_POLL_MS)
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
      // A query may have read before one of those changes: refetch every query on a tag they own.
      for (const [tag, owners] of frame.loaded?.tags ?? []) {
        if (!owners.some((owner) => frame.dirty.has(owner))) continue
        changedWhileMatching?.add(tag)
        refreshTag(tag)
      }
    })
    const held = new Set<string>()
    for (const frame of frames) {
      if (!frame.installed || frame.loaded === undefined) continue
      for (const tag of frame.loaded.tags.keys()) {
        held.add(tag)
        if (!heldSince.has(tag)) heldSince.set(tag, frame.loaded.tick)
      }
    }
    for (const tag of heldSince.keys()) if (!held.has(tag)) heldSince.delete(tag)
    cover()
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
    changedWhileMatching?.add(tag)
    if (!matched.has(tag)) return
    if (delay === 0) refreshTag(tag)
    else setTimeout(() => refreshTag(tag), delay)
  }

  // --- Query hooks ---------------------------------------------------------------------------------

  const refreshTag = (tag: string): void => {
    for (const query of matched.get(tag) ?? []) query.refresh()
  }

  /** Refetch each query that asked for its data before its tag's watch, or its own registration, began. */
  const cover = (): void => {
    for (const [tag, queries] of matched) {
      const held = heldSince.get(tag)
      if (held === undefined) continue
      for (const query of queries) {
        const since = Math.max(held, registeredAt(query) ?? Number.POSITIVE_INFINITY)
        if (query.tick() < since) query.refresh()
      }
    }
  }

  const scheduleMatch = (): void => {
    if (stopped) return
    // From here until the match lands, a change may concern a query it has not matched yet.
    changedWhileMatching ??= new Set()
    if (matchScheduled) return
    matchScheduled = true
    queueMicrotask(() => {
      matchScheduled = false
      matchQueries().catch(() => {})
    })
  }

  const digestOf = (salt: string, key: string): Promise<string> => {
    let digester = digesters.get(salt)
    if (digester === undefined) {
      digester = { sign: queryDigester(salt), made: new Map() }
      digesters.set(salt, digester)
    }
    let made = digester.made.get(key)
    if (made === undefined) {
      const { sign } = digester
      made = sign.then((digest) => digest(key))
      digester.made.set(key, made)
    }
    return made
  }

  const matchQueries = async (): Promise<void> => {
    const runId = ++matching
    const sources = frames.flatMap((frame) =>
      frame.loaded?.query === undefined ? [] : [frame.loaded.query],
    )
    const registered = [...liveQueries()]
    const next = new Map<string, Set<LiveQuery>>()
    const found = new Set<string>()
    for (const source of sources) {
      const { salt } = source
      if (salt === undefined) continue
      await Promise.all(
        registered.flatMap((query) =>
          query.keys().map(async (key) => {
            const tag = source.tags.get(await digestOf(salt, key))
            if (tag === undefined) return
            found.add(key)
            let queries = next.get(tag)
            if (queries === undefined) {
              queries = new Set()
              next.set(tag, queries)
            }
            queries.add(query)
          }),
        ),
      )
    }
    if (runId !== matching || stopped) return
    const salts = new Set(sources.map((source) => source.salt))
    for (const salt of digesters.keys()) if (!salts.has(salt)) digesters.delete(salt)
    const changed = changedWhileMatching ?? new Set<string>()
    changedWhileMatching = undefined
    const previous = matched
    matched = next
    // A change that arrived while this ran found the old match: refetch what only this one has.
    for (const tag of changed) {
      for (const query of next.get(tag) ?? []) if (!previous.get(tag)?.has(query)) query.refresh()
    }
    cover()
    if (registered.length > 0 && sources.length === frames.length)
      warnUnmatched(sources, registered, found)
  }

  /** Development only: a query key nothing on the page grants never refetches. */
  const warnUnmatched = (
    sources: readonly QueryKeys[],
    registered: readonly LiveQuery[],
    found: ReadonlySet<string>,
  ): void => {
    if (!sources.some((source) => source.dev)) return
    if (sources.every((source) => source.salt === undefined)) {
      if (warned.has("")) return
      warned.add("")
      console.warn(
        "[nifra/web] a query names live keys, but the app's live() has queryKeys off: no change refetches it",
      )
      return
    }
    for (const query of registered) {
      for (const key of query.keys()) {
        if (found.has(key) || warned.has(key)) continue
        warned.add(key)
        console.warn(
          `[nifra/web] query live key "${key}" is not granted by any loader on this page: a change to it never refetches the query`,
        )
      }
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
        const spread = value.spread
        welcomeSpread =
          typeof spread === "number" && spread > 0 ? Math.min(spread, MAX_SPREAD_MS) : 0
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
    // No watch survives the socket: changes until the next `ready` are not known.
    heldSince.clear()
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
    if (wantsSocket()) {
      reconnect = setTimeout(
        connect,
        jittered(base * 2 ** Math.min(connectFailures, 5), MAX_RECONNECT_MS),
      )
    }
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
      unwatchQueries = watchLiveQueries(scheduleMatch)
      globalThis.document?.addEventListener("visibilitychange", onVisible)
      globalThis.addEventListener?.("focus", onFocus)
      connect()
      reconcile()
      return () => {
        stopped = true
        unsubscribe()
        unwatchQueries?.()
        unwatchQueries = undefined
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
  readonly subjects: readonly string[]
  readonly grant?: string
  readonly tags?: Readonly<Record<string, readonly string[]>>
  readonly page?: "retained"
  readonly ttl?: number
  readonly query?: QueryKeys
}

const MAX_SALT_CHARS = 64
const MAX_DIGEST_CHARS = 64
/** One per listed secret, at most three. */
const MAX_SUBJECTS = 3
const MAX_SUBJECT_CHARS = 64

/** The envelope's `query` member, or `undefined` for anything else in its place. */
function queryKeysOf(value: unknown): QueryKeys | undefined {
  if (!isRecord(value)) return undefined
  const { salt, keys, dev } = value
  if (dev !== undefined && dev !== true) return undefined
  if (salt !== undefined && (typeof salt !== "string" || salt.length > MAX_SALT_CHARS))
    return undefined
  const tags = new Map<string, string>()
  if (keys !== undefined) {
    if (!isRecord(keys)) return undefined
    for (const [tag, digest] of Object.entries(keys)) {
      if (typeof digest !== "string" || digest.length > MAX_DIGEST_CHARS) return undefined
      tags.set(digest, tag)
    }
  }
  return { salt, tags, dev: dev === true }
}

/** The server's live envelope, or `undefined` for anything else in its place. */
function envelopeOf(value: unknown): ServerEnvelope | undefined {
  if (!isRecord(value)) return undefined
  const { subjects, grant, tags, page, ttl, query } = value
  if (
    !Array.isArray(subjects) ||
    subjects.length === 0 ||
    subjects.length > MAX_SUBJECTS ||
    !subjects.every((tag) => typeof tag === "string" && tag.length <= MAX_SUBJECT_CHARS)
  ) {
    return undefined
  }
  const queryKeys = query === undefined ? undefined : queryKeysOf(query)
  if (query !== undefined && queryKeys === undefined) return undefined
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
    subjects: readonly string[]
    tags: Record<string, readonly string[]>
    grant?: string
    page?: "retained"
    ttl?: number
    query?: QueryKeys
  } = { subjects, tags: owned }
  if (typeof grant === "string") envelope.grant = grant
  if (page === "retained") envelope.page = page
  if (typeof ttl === "number") envelope.ttl = ttl
  if (queryKeys !== undefined) envelope.query = queryKeys
  return envelope
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A minute before `loaded` expires, less up to 30 s of jitter; a short grant renews a third early. */
const renewAtOf = (loaded: Loaded): number =>
  loaded.expiresAt -
  Math.min(RENEW_BEFORE_MS, loaded.ttlMs / 3) -
  Math.random() * Math.min(RENEW_JITTER_MS, loaded.ttlMs / 6)

/** The promise of a value the NDJSON stream settles later, as the data reader marks one. */
const deferredOf = (value: unknown): Promise<unknown> | undefined =>
  isRecord(value) && value.__nifra_deferred === true && value.promise instanceof Promise
    ? value.promise
    : undefined

/** `ms` spread over +/-20%, capped. */
const jittered = (ms: number, max: number): number =>
  Math.min(max, ms * (0.8 + Math.random() * 0.4))

function randomSid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}
