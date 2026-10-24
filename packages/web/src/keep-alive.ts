/**
 * @nifrajs/web/keep-alive - pages that stay mounted after the visitor leaves them, so back and forward
 * show them again as they were left. The generated client entry imports this only when a route
 * exports `keepAlive`, so no other app's client chunks contain it.
 *
 * {@link keepAliveClient} layers over the router. The page on screen is kept when a push or a
 * back/forward traversal leaves it (at most three, each for at most ten minutes, all dropped when the
 * visitor signs in or out); a traversal back to a kept page's own history entry publishes that page at
 * once, then reloads its data in place. Adapters render the active page and every kept one from
 * {@link slotTree}, and {@link createSlotParking} takes the hidden ones out of the document.
 */
import { epochOf, IDENTITY_CHANNEL, onIdentityChange } from "./identity.ts"
import type { KeepAliveTable } from "./internal/keep-alive-table.ts"
import { PAGE_HIDE_EVENT, PAGE_SHOW_EVENT } from "./internal/page-events.ts"
import { shareData } from "./internal/share-data.ts"
import type { ClientRouteHooks, KeepAliveOptions } from "./manifest.ts"
import type { MatchChain } from "./render-seam.ts"
import {
  type ClientRouter,
  type Fetcher,
  type FetchRouteData,
  fetchRouteData,
  isRouteDataEnvelope,
  type KeptPage,
  type RouterState,
} from "./router.ts"

export { EPOCH_COOKIE, IDENTITY_CHANNEL, identityChanged } from "./identity.ts"
export type { KeepAliveTable } from "./internal/keep-alive-table.ts"
export { PAGE_HIDE_EVENT, PAGE_SHOW_EVENT } from "./internal/page-events.ts"

/** Most pages kept per tab. */
export const KEEP_ALIVE_MAX = 3
/** Longest a page stays hidden unless its route sets `keepAlive: { maxAge }`, in milliseconds. */
export const KEEP_ALIVE_MAX_AGE_MS = 10 * 60 * 1000

/** Why kept pages were dropped. */
export type KeepAliveDropReason =
  /** The visitor signed in or out (the epoch cookie changed, or another tab said so). */
  | "identity"
  /** The document entered the browser's own back/forward cache. */
  | "pagehide"
  /** A push cut off the history entries they belonged to. */
  | "forward"
  /** A fourth page was kept; the least recently shown went. */
  | "lru"
  /** Hidden longer than its route's `maxAge`. */
  | "expired"
  /** Its chain leaves the page on screen at a layout rendered without slot wrappers. */
  | "layout"
  /** A route module was replaced by a hot update. */
  | "hot-update"
  /** `dropKept` was called. */
  | "manual"

/** Per-navigation options of {@link KeepAliveRouter.navigate}. */
export interface KeepAliveNavigateOptions {
  /** The instance of the history entry a back/forward lands on. Read from `history.state` when absent. */
  readonly traverse?: string
}

/** The router as {@link keepAliveClient} hands it to the history layer and the adapter. */
export interface KeepAliveRouter extends ClientRouter {
  navigate: (path: string, options?: KeepAliveNavigateOptions) => Promise<void>
  /** Drop every kept page. */
  dropKept: (reason?: KeepAliveDropReason) => void
  /** Run `listener` with each state before it is published: the DOM half reads what the next render
   * hides or shows again while the page being left is still laid out. Returns its removal. */
  beforePublish: (listener: (next: RouterState) => void) => () => void
}

export interface KeepAliveClientOptions {
  /** Where the slot wrappers go (generated from the route table). */
  readonly table: KeepAliveTable
  /** Route id → its client hooks, filled in as route modules load. A page is kept only while its
   * module exports `keepAlive`. */
  readonly routeHooks: Readonly<Record<string, ClientRouteHooks | undefined>>
  /** Route id → its layout ids then its own id, filled in as route modules load. */
  readonly matchChains: Readonly<Record<string, MatchChain | undefined>>
  /** The transport to layer over (a live app's); the router's own by default. */
  readonly fetchData?: FetchRouteData
  /** Most pages kept (default {@link KEEP_ALIVE_MAX}). */
  readonly max?: number
  /** Called with the instances each drop removed. */
  readonly onDrop?: (reason: KeepAliveDropReason, instances: readonly string[]) => void
}

/** What {@link keepAliveClient} returns: the transport to build the router with, then the layer. */
export interface KeepAliveClient {
  /** Pass as `createClientRouter({ fetchData })`, so a restored page's reload keeps what it showed. */
  readonly fetchData: FetchRouteData
  /** Layer keep-alive over the router built with {@link fetchData}. Call once, before
   * `installHistory`. */
  attach(router: ClientRouter): KeepAliveRouter
}

interface Entry {
  readonly index: number
  readonly instance: string | undefined
}

interface Kept {
  readonly page: KeptPage
  readonly index: number
  readonly epoch: string
  readonly hiddenAt: number
  readonly maxAge: number
  readonly revalidate: boolean
  stale: boolean
}

interface Restore {
  /** The URL of the history entry restored: the page's, or the target its boundary holds. */
  readonly path: string
  /** The URL the page's own data reloads from. */
  readonly pagePath: string
  readonly kept: RouterState
  readonly reload: boolean
}

const pathnameOf = (path: string): string => {
  const q = path.indexOf("?")
  return q === -1 ? path : path.slice(0, q)
}
const pagePathOf = (state: RouterState): string => state.intercepted?.pagePath ?? state.path

// Unique per document, so an instance an entry carries from an earlier document never names one here.
const DOCUMENT = Math.random().toString(36).slice(2, 8)
let sequence = 0
const newInstance = (): string => `${++sequence}:${DOCUMENT}`
const ownInstance = (value: unknown): string | undefined =>
  typeof value === "string" && value.endsWith(`:${DOCUMENT}`) ? value : undefined

const readEntry = (): Entry => {
  const state: unknown = typeof history === "undefined" ? null : history.state
  const fields = typeof state === "object" && state !== null ? state : {}
  const index = Reflect.get(fields, "nifraIndex")
  return {
    index: typeof index === "number" ? index : 0,
    instance: ownInstance(Reflect.get(fields, "nifraInstance")),
  }
}
// The instance rides on the entry beside the history layer's own fields, which every write it makes
// to an existing entry keeps; a fresh push or replace carries none.
const stampEntry = (instance: string): void => {
  if (typeof history === "undefined") return
  const state: unknown = history.state
  if (
    typeof state === "object" &&
    state !== null &&
    Reflect.get(state, "nifraInstance") === instance
  )
    return
  try {
    history.replaceState(
      Object.assign({}, typeof state === "object" ? state : null, { nifraInstance: instance }),
      "",
    )
  } catch {}
}

const readEpoch = (): string => (typeof document === "undefined" ? "" : epochOf(document.cookie))
const now = (): number => Date.now()

/**
 * Keep-alive for a router. See the module docs; the generated client entry wires it:
 *
 * ```ts
 * const keep = keepAliveClient({ table, routeHooks, matchChains })
 * const router = keep.attach(createClientRouter({ ..., fetchData: keep.fetchData }))
 * installHistory(router)
 * ```
 */
export function keepAliveClient(options: KeepAliveClientOptions): KeepAliveClient {
  const { table, routeHooks, matchChains } = options
  const base = options.fetchData ?? fetchRouteData
  const max = options.max ?? KEEP_ALIVE_MAX
  const keepRoutes = new Set(table.routes)
  const wrappedLayouts = new Set(table.layouts)
  // The restore whose reload the router is running, which the transport answers.
  let reloading: Restore | undefined

  // A restored page's reload: its kept data, unrequested, when it needs no reload; otherwise the
  // response shared onto the kept data, so what did not change keeps the identity it has on screen.
  // A reload that fails shows the kept data instead of loading the page as a document.
  const fetchData: FetchRouteData = async (
    path,
    match,
    signal,
    navigation,
    purpose,
    hosts,
    read,
  ) => {
    const restore = reloading
    const held = restore?.kept.intercepted
    // A page kept with a boundary open reloads twice: its own data, then the target the boundary holds.
    const target =
      held !== undefined && path === restore?.kept.path && path !== restore.pagePath
        ? restore.kept.boundaries?.[held.boundary]
        : undefined
    if (restore === undefined || (path !== restore.pagePath && target === undefined)) {
      return base(path, match, signal, navigation, purpose, hosts, read)
    }
    const kept = (): unknown =>
      target === undefined
        ? envelopeOf(restore.kept)
        : { v: 1, data: target.data, live: target.live }
    // The page's hole hosts reload as fills, applied in place on the roots kept with it, even when
    // the route keeps its own data.
    const holes = target === undefined ? hostsOf(restore.kept) : []
    if (!restore.reload && holes.length === 0) return kept()
    let payload: unknown
    try {
      payload = await base(
        path,
        match,
        signal,
        navigation,
        purpose,
        holes.length === 0 ? hosts : holes,
        read,
      )
    } catch (error) {
      if (signal?.aborted === true || hasRedirect(error)) throw error
      return kept()
    }
    if (!restore.reload) return fillsOnto(restore.kept, payload, holes)
    const hooks = routeHooks[target === undefined ? restore.kept.routeId : match.routeId]
    // `read` itself answers a reload whose response text is what the path shows, which the router
    // keeps unparsed.
    if (payload === read || hooks?.shareData === false) return payload
    // The router's transport records the text of a plain JSON response, a tree with no symbol keys.
    const plainJson = read?.text !== undefined && hooks?.clientLoader === undefined
    return target === undefined
      ? sharedOnto(restore.kept, payload, plainJson)
      : targetOnto(target.data, payload, plainJson)
  }

  const attach = (inner: ClientRouter): KeepAliveRouter => {
    const records = new Map<string, Kept>()
    const listeners = new Set<() => void>()
    const before = new Set<(next: RouterState) => void>()
    const wrappedFetchers = new Map<string, Fetcher>()
    let keptPages: readonly KeptPage[] | undefined
    let lastEpoch = readEpoch()

    const first = readEntry()
    let active = {
      instance: first.instance ?? newInstance(),
      index: first.index,
      settled: inner.snapshot(),
    }
    stampEntry(active.instance)
    if (typeof process !== "undefined" && process.env.NODE_ENV !== "production")
      Reflect.set(globalThis, KEPT_PAGES_GLOBAL, {
        pages: () => describeKept(records.values()),
      })
    // What is on screen: the router's state, or a restored page's kept state until its reload lands.
    let shown = active.settled
    let flags: Partial<RouterState> | undefined
    // The page being left stays mounted, hidden, while a `_loading` page takes its place.
    let leaving = false
    // The page being left is gone (dropped, or unmountable) before its navigation settled.
    let leftGone = false

    const keepAliveOf = (routeId: string): true | KeepAliveOptions | undefined =>
      keepRoutes.has(routeId) ? routeHooks[routeId]?.keepAlive : undefined
    // A boundary open over the page is kept with it (its target is the page's to show again).
    const keepable = (state: RouterState): boolean =>
      !state.pending && keepAliveOf(state.routeId) !== undefined
    // One page instance per route, and per pathname on a route that keeps alive, whose pages would
    // otherwise have nothing to keep.
    const sameInstance = (a: RouterState, b: RouterState): boolean =>
      a.routeId === b.routeId &&
      (!keepRoutes.has(b.routeId) || pathnameOf(pagePathOf(a)) === pathnameOf(pagePathOf(b)))

    const compose = (): RouterState => {
      keptPages ??= [...records.values()].map((record) => record.page)
      const kept = leaving
        ? [...keptPages, { instance: active.instance, state: active.settled }]
        : keptPages
      return {
        ...shown,
        instance: leaving ? undefined : active.instance,
        kept: kept.length === 0 ? undefined : kept,
        ...flags,
      }
    }
    let published = compose()

    const drop = (instances: readonly string[], reason: KeepAliveDropReason): void => {
      const gone = instances.filter((instance) => records.delete(instance))
      if (gone.length === 0) return
      keptPages = undefined
      options.onDrop?.(reason, gone)
    }
    const refresh = (): void => {
      let next = compose()
      // A kept page whose chain leaves the page on screen at an unwrapped layout cannot be hidden.
      const stuck = unplaceable(next, matchChains, keepRoutes, wrappedLayouts)
      if (stuck.length > 0) {
        if (leaving && stuck.includes(active.instance)) {
          leaving = false
          leftGone = true
        }
        drop(stuck, "layout")
        next = compose()
      }
      for (const listener of [...before]) listener(next)
      published = next
      for (const listener of [...listeners]) listener()
    }
    const dropKept = (reason: KeepAliveDropReason = "manual"): void => {
      const left = leaving || inner.snapshot().pending
      if (records.size === 0 && !leaving) {
        if (left) leftGone = true
        return
      }
      if (left) {
        leaving = false
        leftGone = true
      }
      drop([...records.keys()], reason)
      refresh()
    }
    const sweep = (): void => {
      const at = now()
      const expired: string[] = []
      for (const [instance, record] of records)
        if (at - record.hiddenAt > record.maxAge) expired.push(instance)
      drop(expired, "expired")
    }
    // A response or another tab may carry a new epoch: what was kept belonged to the previous visitor.
    const checkEpoch = (): void => {
      const epoch = readEpoch()
      if (epoch === lastEpoch) return
      lastEpoch = epoch
      channel?.postMessage("changed")
      dropKept("identity")
    }

    const keep = (instance: string, index: number, state: RouterState): void => {
      if (!keepable(state)) return
      const setting = keepAliveOf(state.routeId)
      const settings = typeof setting === "object" ? setting : {}
      records.delete(instance)
      records.set(instance, {
        page: { instance, state },
        index,
        epoch: readEpoch(),
        hiddenAt: now(),
        maxAge: settings.maxAge ?? KEEP_ALIVE_MAX_AGE_MS,
        revalidate: settings.revalidate !== false,
        stale: false,
      })
      keptPages = undefined
      if (records.size > max) drop([...records.keys()].slice(0, records.size - max), "lru")
    }

    const settle = (next: RouterState): void => {
      const entry = readEntry()
      if (sameInstance(active.settled, next)) {
        active = { instance: active.instance, index: entry.index, settled: next }
      } else {
        // The page on screen was left: by a push (a fresh entry above it), a traversal (an entry that
        // already carries an instance), or a replace (its own entry rewritten), which discards it.
        if (entry.index > active.index && entry.instance === undefined) {
          drop(
            [...records].filter(([, record]) => record.index >= entry.index).map(([id]) => id),
            "forward",
          )
        }
        if (entry.index !== active.index && !leftGone)
          keep(active.instance, active.index, active.settled)
        const reuse =
          entry.index !== active.index &&
          entry.instance !== undefined &&
          entry.instance !== active.instance &&
          !records.has(entry.instance)
            ? entry.instance
            : undefined
        active = { instance: reuse ?? newInstance(), index: entry.index, settled: next }
      }
      stampEntry(active.instance)
      sweep()
      shown = next
      flags = undefined
      leaving = false
      leftGone = false
      refresh()
      checkEpoch()
    }

    let restoring:
      | (Restore & { readonly done: () => void; readonly ended: Promise<void> })
      | undefined
    const endRestore = (): void => {
      const restore = restoring
      restoring = undefined
      reloading = undefined
      restore?.done()
    }

    inner.subscribe(() => {
      const next = inner.snapshot()
      const restore = restoring
      if (restore !== undefined) {
        // The restored page stays on screen while its reload runs: the router's own pending tick for
        // it is not a navigation the visitor made. A redirect it follows is.
        if (
          next.pending &&
          (next.pendingPath === undefined ||
            next.pendingPath === restore.path ||
            next.pendingPath === restore.pagePath)
        )
          return
        const onPage =
          !next.pending &&
          pagePathOf(next) === restore.pagePath &&
          next.routeId === restore.kept.routeId
        // The page alone, on the way to opening its boundary on the target again.
        if (onPage && restore.kept.intercepted !== undefined && next.intercepted === undefined)
          return
        endRestore()
        if (onPage) {
          active = { instance: active.instance, index: active.index, settled: next }
          shown = { ...next, params: shareData(restore.kept.params, next.params) }
          flags = undefined
          refresh()
          checkEpoch()
          return
        }
      }
      if (!next.pending) {
        settle(next)
        return
      }
      shown = next
      flags = undefined
      leaving = next.routeId !== active.settled.routeId && !leftGone && keepable(active.settled)
      refresh()
    })

    const restore = (path: string, instance: string, record: Kept): Promise<void> => {
      const entry = readEntry()
      records.delete(instance)
      keptPages = undefined
      if (!leftGone) keep(active.instance, active.index, active.settled)
      const kept = record.page.state
      active = { instance, index: entry.index, settled: kept }
      const reload = record.revalidate || record.stale || kept.path !== path
      const modal = kept.intercepted
      const pagePath = modal === undefined ? path : modal.pagePath
      let done = (): void => {}
      const ended = new Promise<void>((resolve) => {
        done = resolve
      })
      endRestore()
      const mine = { path, pagePath, kept, reload, done, ended }
      restoring = mine
      reloading = { path, pagePath, kept, reload }
      stampEntry(instance)
      shown = kept
      flags = { restored: true, revalidating: reload }
      leaving = false
      leftGone = false
      refresh()
      // The router shows a boundary's target only over the page it opened on: it loads the page, then
      // opens the boundary on the target again, as the link that first opened it did.
      const reloaded =
        modal === undefined
          ? inner.navigate(path)
          : inner.navigate(pagePath).then(() => {
              const now = inner.snapshot()
              const onPage =
                restoring === mine &&
                !now.pending &&
                now.routeId === kept.routeId &&
                pagePathOf(now) === pagePath
              return onPage ? inner.navigate(path) : undefined
            })
      return reloaded.finally(() => {
        if (restoring === mine) endRestore()
      })
    }

    const navigate = (path: string, navOptions?: KeepAliveNavigateOptions): Promise<void> => {
      sweep()
      const instance = navOptions?.traverse ?? readEntry().instance
      const record =
        instance === undefined || instance === active.instance ? undefined : records.get(instance)
      if (instance !== undefined && record !== undefined) {
        if (record.epoch !== readEpoch()) dropKept("identity")
        else if (pathnameOf(record.page.state.path) === pathnameOf(path))
          return restore(path, instance, record)
      }
      endRestore()
      return inner.navigate(path)
    }

    // A submit or an invalidation may change what a hidden page shows; the response that says which
    // paths (`X-Nifra-Revalidate`) is read inside the router, so every kept page reloads when shown.
    const markStale = (paths?: readonly string[]): void => {
      for (const record of records.values()) {
        const { state } = record.page
        if (paths === undefined || paths.includes(pagePathOf(state)) || paths.includes(state.path))
          record.stale = true
      }
    }
    // A submit or an invalidation acts on the page on screen, which a restore hands to the router only
    // once its reload settles.
    const afterRestore = async (): Promise<void> => {
      while (restoring !== undefined) await restoring.ended
    }

    const channel =
      typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(IDENTITY_CHANNEL)
    const identityDrop = (): void => {
      lastEpoch = readEpoch()
      dropKept("identity")
    }
    channel?.addEventListener("message", identityDrop)
    onIdentityChange(identityDrop)
    if (typeof addEventListener === "function") {
      addEventListener("pagehide", (event) => {
        if ("persisted" in event && event.persisted === true) dropKept("pagehide")
      })
      addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkEpoch()
      })
    }

    return {
      snapshot: () => published,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      navigate,
      submit: async (action, body, submitOptions) => {
        await afterRestore()
        try {
          await inner.submit(action, body, submitOptions)
        } finally {
          markStale()
          checkEpoch()
        }
      },
      hydrate: () => inner.hydrate(),
      invalidate: (paths) => {
        markStale(paths)
        // At once when nothing is restoring: the live client names its load around this call.
        return restoring === undefined
          ? inner.invalidate(paths)
          : afterRestore().then(() => inner.invalidate(paths))
      },
      prefetch: (path) => inner.prefetch(path),
      fetcher: (key) => {
        let fetcher = wrappedFetchers.get(key)
        if (fetcher === undefined) {
          const own = inner.fetcher(key)
          fetcher = {
            snapshot: own.snapshot,
            subscribe: own.subscribe,
            load: own.load,
            submit: async (action, body) => {
              try {
                await own.submit(action, body)
              } finally {
                markStale()
                checkEpoch()
              }
            },
          }
          wrappedFetchers.set(key, fetcher)
        }
        return fetcher
      },
      fetchers: () => inner.fetchers(),
      subscribeFetchers: (listener) => inner.subscribeFetchers(listener),
      match: (path) => inner.match(path),
      dropKept,
      beforePublish: (listener) => {
        before.add(listener)
        return () => {
          before.delete(listener)
        }
      },
    }
  }

  return { fetchData, attach }
}

const hasRedirect = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  typeof Reflect.get(error, "redirectTo") === "string"

/** A held target's reload, its data shared onto what the boundary shows. */
const targetOnto = (shown: unknown, payload: unknown, plainJson: boolean): unknown => {
  if (!isRouteDataEnvelope(payload)) return shareData(shown, payload, plainJson)
  if (payload.status !== undefined) return payload
  return { ...payload, data: shareData(shown, payload.data, plainJson) }
}

/** The holes of `state`'s page that are hosts a partially prerendered document left open. */
const hostsOf = (state: RouterState): string[] =>
  Object.values(state.boundaries ?? {})
    .filter((held) => held.ppr === true)
    .map((held) => held.name)

/** What `kept` shows, with the fills `payload` carries for its hole hosts `holes` and nothing else
 * of it. */
const fillsOnto = (kept: RouterState, payload: unknown, holes: readonly string[]): unknown => {
  const envelope = envelopeOf(kept)
  if (!isRouteDataEnvelope(payload) || payload.status !== undefined) return envelope
  const boundaries = { ...kept.boundaries }
  for (const name of holes) {
    const fill = payload.boundaries?.[name]
    if (fill?.ppr === true) boundaries[name] = fill
  }
  return { ...envelope, boundaries }
}

/** A route data envelope that publishes exactly `state`'s data. */
const envelopeOf = (state: RouterState): Record<string, unknown> => {
  const envelope: Record<string, unknown> = {
    v: 1,
    data: state.data,
    layoutData: state.layoutData,
    serverComponents: state.serverComponents,
    live: state.live,
  }
  if (state.boundaries !== undefined) envelope.boundaries = state.boundaries
  return envelope
}

/** `payload` with every part equal to what `kept` shows replaced by that part. A layout the server
 * skipped (`retained`) takes the value on screen, as on any navigation. */
const sharedOnto = (kept: RouterState, payload: unknown, plainJson: boolean): unknown => {
  if (!isRouteDataEnvelope(payload)) return shareData(kept.data, payload, plainJson)
  if (payload.status !== undefined) return payload
  const retained = new Set(payload.retained ?? [])
  return {
    ...payload,
    data: shareData(kept.data, payload.data, plainJson),
    layoutData: payload.layoutData?.map((value, index) =>
      retained.has(index) ? value : shareData(kept.layoutData?.[index], value, plainJson),
    ),
    ...(payload.boundaries === undefined
      ? {}
      : { boundaries: shareData(kept.boundaries, payload.boundaries, plainJson) }),
    serverComponents: shareData(kept.serverComponents, payload.serverComponents, plainJson),
  }
}

/** One element of the view: a layout and the slots under it, or a page. */
export interface SlotNode {
  /** Unique in the tree: a layout's id, or `\0` and a page instance. */
  readonly key: string
  /** The chain index of the element it renders: a layout's depth, or the page's (its route's layout
   * count), from where the page's own chain (an `_error` boundary, then the page) continues. */
  readonly depth: number
  /** The state it renders from: the page on screen's while it is on the path to it, else the most
   * recently shown kept page under it. */
  readonly state: RouterState
  /** Not on the path to the page on screen. */
  readonly hidden: boolean
  /** Rendered inside the two slot wrappers, so it can be taken out of the document. */
  readonly wrapped: boolean
  /** The slots under a layout, in the order their pages were first shown. Absent on a page. */
  readonly children?: readonly SlotNode[]
}

interface Member {
  readonly key: string
  readonly order: number
  readonly recency: number
  readonly state: RouterState
  readonly hidden: boolean
  readonly layouts: readonly string[]
  readonly leaf: string
}

const NO_LAYOUTS: readonly string[] = []
// The `_loading` page shown while a navigation runs has no instance of its own.
const LOADING = "\0loading"

const memberOf = (
  instance: string | undefined,
  state: RouterState,
  hidden: boolean,
  recency: number,
  chains: Readonly<Record<string, MatchChain | undefined>>,
): Member => {
  const ids = chains[state.routeId]?.ids
  const order = instance === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(instance, 10)
  return {
    key: instance === undefined ? LOADING : `\0${instance}`,
    order: Number.isNaN(order) ? Number.MAX_SAFE_INTEGER : order,
    recency,
    state,
    hidden,
    layouts: ids === undefined ? NO_LAYOUTS : ids.slice(0, -1),
    leaf: ids?.at(-1) ?? state.routeId,
  }
}

const membersOf = (
  state: RouterState,
  chains: Readonly<Record<string, MatchChain | undefined>>,
): Member[] => {
  const kept = state.kept ?? []
  const members = kept.map((page, i) => memberOf(page.instance, page.state, true, i, chains))
  members.push(memberOf(state.instance, state, false, kept.length, chains))
  return members.sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1))
}

const levelOf = (
  members: readonly Member[],
  depth: number,
  pages: ReadonlySet<string>,
  layouts: ReadonlySet<string>,
  previous: ReadonlyMap<string, SlotNode>,
): SlotNode[] => {
  const groups = new Map<string, Member[]>()
  for (const member of members) {
    const key = member.layouts[depth] ?? member.key
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [member])
    else group.push(member)
  }
  const nodes: SlotNode[] = []
  for (const [key, group] of groups) {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a group is created with its first member
    const head = group[0] as Member
    if (key === head.key) {
      nodes.push(
        reuse(previous, {
          key,
          depth,
          state: head.state,
          hidden: head.hidden,
          wrapped: pages.has(head.leaf),
        }),
      )
      continue
    }
    let shown = head
    for (const member of group) {
      if (!member.hidden) {
        shown = member
        break
      }
      if (member.recency > shown.recency) shown = member
    }
    nodes.push(
      reuse(previous, {
        key,
        depth,
        state: shown.state,
        hidden: shown.hidden,
        wrapped: layouts.has(key),
        children: levelOf(group, depth + 1, pages, layouts, previous),
      }),
    )
  }
  return nodes
}

// The previous tree's node when nothing about it changed, so a renderer that memoizes on the node
// skips it: a hidden page never re-renders while it is hidden.
const reuse = (previous: ReadonlyMap<string, SlotNode>, node: SlotNode): SlotNode => {
  const old = previous.get(node.key)
  if (
    old === undefined ||
    old.depth !== node.depth ||
    old.state !== node.state ||
    old.hidden !== node.hidden ||
    old.wrapped !== node.wrapped
  )
    return node
  const a = old.children
  const b = node.children
  if (a === b) return old
  if (a === undefined || b === undefined || a.length !== b.length) return node
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return node
  return old
}

const indexTree = (nodes: readonly SlotNode[], into: Map<string, SlotNode>): void => {
  for (const node of nodes) {
    into.set(node.key, node)
    if (node.children !== undefined) indexTree(node.children, into)
  }
}

/**
 * The view of `state`: the page on screen and every kept page, grouped by the layouts they share. A
 * layout every page under it shares renders once; where two chains part, each part is a slot. Pass
 * the previous tree to keep the identity of every node that did not change.
 */
export function slotTree(
  state: RouterState,
  chains: Readonly<Record<string, MatchChain | undefined>>,
  table: KeepAliveTable,
  previous?: readonly SlotNode[],
): readonly SlotNode[] {
  const before = new Map<string, SlotNode>()
  if (previous !== undefined) indexTree(previous, before)
  return levelOf(membersOf(state, chains), 0, new Set(table.routes), new Set(table.layouts), before)
}

// The kept pages a render of `state` could not hide: their chain leaves the page on screen at a
// layout rendered without slot wrappers.
const unplaceable = (
  state: RouterState,
  chains: Readonly<Record<string, MatchChain | undefined>>,
  pages: ReadonlySet<string>,
  layouts: ReadonlySet<string>,
): string[] => {
  if (state.kept === undefined) return []
  const stuck: string[] = []
  const visit = (nodes: readonly SlotNode[], parentHidden: boolean): void => {
    for (const node of nodes) {
      if (node.hidden && !parentHidden && !node.wrapped) collect(node, stuck)
      else if (node.children !== undefined) visit(node.children, node.hidden)
    }
  }
  visit(levelOf(membersOf(state, chains), 0, pages, layouts, new Map()), false)
  return stuck
}

const collect = (node: SlotNode, into: string[]): void => {
  if (node.children === undefined) {
    if (node.key !== LOADING) into.push(node.key.slice(1))
    return
  }
  for (const child of node.children) collect(child, into)
}

/** The DOM half of keep-alive: takes hidden slots out of the document and puts them back. */
export interface SlotParking {
  /** The ref of a slot's outer wrapper (`data-nifra-entry`). Stable per key. */
  entry(key: string): (element: Element | null) => void
  /** The ref of a slot's inner wrapper (`data-nifra-page`), the element that is parked. Stable per key. */
  page(key: string): (element: Element | null) => void
  /** Before the render of `next`: put back what it shows again, and note the inner scroll offsets and
   * focus of what it hides while that is still laid out (React hides it during the commit). */
  before(next: readonly SlotNode[]): void
  /** After the render of `tree` committed: park what it hides, restore what it shows again. */
  after(tree: readonly SlotNode[]): void
}

interface Parked {
  entry?: Element | undefined
  page?: Element | undefined
  parked: boolean
  shown: boolean
  showing: boolean
  /** The hide event went out and no show event since. */
  hid: boolean
  next: Node | null
  offsets: (readonly [Element, number, number])[] | undefined
  focus: Element | undefined
  checked: boolean
}

const scrollOffsets = (page: Element): (readonly [Element, number, number])[] => {
  const offsets: (readonly [Element, number, number])[] = []
  if (page.scrollTop !== 0 || page.scrollLeft !== 0)
    offsets.push([page, page.scrollTop, page.scrollLeft])
  for (const element of page.querySelectorAll("*")) {
    if (element.scrollTop !== 0 || element.scrollLeft !== 0)
      offsets.push([element, element.scrollTop, element.scrollLeft])
  }
  return offsets
}

/** What a page showed as it was hidden, put back by {@link PageView.restore}. */
export interface PageView {
  /** Put back the inner scroll offsets and the focus, once the page is in the document again. */
  restore(): void
}

/**
 * Note the inner scroll offsets of a page's top-level `elements` and the element inside them that has
 * focus, while they are still laid out. For an adapter whose framework takes a hidden page out of the
 * document itself (Vue's `KeepAlive`), in place of {@link createSlotParking}.
 */
export function rememberView(elements: readonly Element[]): PageView {
  const offsets = elements.flatMap(scrollOffsets)
  const focused = typeof document === "undefined" ? null : document.activeElement
  const focus =
    focused !== null && elements.some((element) => element.contains(focused)) ? focused : undefined
  return {
    restore() {
      for (const [element, top, left] of offsets) {
        if (!element.isConnected) continue
        element.scrollTop = top
        element.scrollLeft = left
      }
      if (focus?.isConnected)
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: it held focus, so it is focusable; the call stays optional
        (focus as HTMLElement).focus?.({ preventScroll: true })
    },
  }
}

const wrappedNodes = (nodes: readonly SlotNode[], into: SlotNode[] = []): SlotNode[] => {
  for (const node of nodes) {
    if (node.wrapped) into.push(node)
    if (node.children !== undefined) wrappedNodes(node.children, into)
  }
  return into
}

// Development only: what each slot renders, by slot key, for the devtools panel's node counts.
const keptViews = new Map<string, () => readonly Element[]>()

/**
 * For an adapter, in development: the elements slot `key` renders, read when the devtools panel
 * counts a kept page's nodes. `undefined` once the slot has left the view.
 */
export function noteKeptView(key: string, elements: (() => readonly Element[]) | undefined): void {
  if (elements === undefined) keptViews.delete(key)
  else keptViews.set(key, elements)
}

/** Where a development build lists its kept pages, for `@nifrajs/devtools`. */
export const KEPT_PAGES_GLOBAL = "__nifraKeepAlive"

/** One kept page, as the devtools panel lists it. */
export interface KeptPageInfo {
  readonly instance: string
  readonly path: string
  readonly routeId: string
  /** How long it has been hidden, in milliseconds. */
  readonly hiddenFor: number
  /** The elements it renders, while its view has them. */
  readonly nodes: number | undefined
}

const describeKept = (records: Iterable<Kept>): KeptPageInfo[] => {
  const at = now()
  return [...records].map(({ page, hiddenAt }) => {
    const elements = keptViews.get(`\0${page.instance}`)?.()
    return {
      instance: page.instance,
      path: page.state.path,
      routeId: page.state.routeId,
      hiddenFor: at - hiddenAt,
      nodes: elements?.reduce(
        (count, element) => count + 1 + element.querySelectorAll("*").length,
        0,
      ),
    }
  })
}

/** One per mounted view. */
export function createSlotParking(): SlotParking {
  const slots = new Map<string, Parked>()
  const entryRefs = new Map<string, (element: Element | null) => void>()
  const pageRefs = new Map<string, (element: Element | null) => void>()
  const slotOf = (key: string): Parked => {
    let slot = slots.get(key)
    if (slot === undefined) {
      slot = {
        parked: false,
        shown: false,
        showing: false,
        hid: false,
        next: null,
        offsets: undefined,
        focus: undefined,
        checked: false,
      }
      slots.set(key, slot)
    }
    return slot
  }
  const remember = (slot: Parked): void => {
    if (slot.page === undefined || slot.offsets !== undefined) return
    slot.offsets = scrollOffsets(slot.page)
    const focused = typeof document === "undefined" ? null : document.activeElement
    slot.focus =
      focused !== null && focused !== slot.page && slot.page.contains(focused) ? focused : undefined
  }
  // Sent while the page is still in the document, before the router's subscribers see the state that
  // hides it, so what holds the page's content (server components) sets it aside first.
  const fire = (slot: Parked, hide: boolean): void => {
    slot.hid = hide
    slot.page?.dispatchEvent(
      new CustomEvent(hide ? PAGE_HIDE_EVENT : PAGE_SHOW_EVENT, { bubbles: true }),
    )
  }
  const unpark = (slot: Parked): void => {
    if (!slot.parked || slot.page === undefined || slot.entry === undefined) return
    slot.entry.insertBefore(slot.page, slot.next?.parentNode === slot.entry ? slot.next : null)
    slot.parked = false
    slot.showing = true
  }
  return {
    entry(key) {
      let ref = entryRefs.get(key)
      if (ref === undefined) {
        ref = (element) => {
          slotOf(key).entry = element ?? undefined
        }
        entryRefs.set(key, ref)
      }
      return ref
    },
    page(key) {
      let ref = pageRefs.get(key)
      if (ref === undefined) {
        // A null never clears the page: React detaches refs inside a hidden `Activity`, and a parked
        // page is still the framework's element. The slot leaving the tree (`after`) drops it.
        ref = (element) => {
          if (element === null) return
          slotOf(key).page = element
          if (typeof process !== "undefined" && process.env.NODE_ENV !== "production")
            noteKeptView(key, () => [element])
        }
        pageRefs.set(key, ref)
      }
      return ref
    },
    before(next) {
      for (const node of wrappedNodes(next)) {
        const slot = slots.get(node.key)
        if (slot === undefined) continue
        if (node.hidden) {
          if (!slot.shown) continue
          remember(slot)
          if (!slot.hid && slot.page !== undefined) fire(slot, true)
        } else {
          // Shown again before it was parked: it never left the document.
          if (slot.hid && !slot.parked) fire(slot, false)
          unpark(slot)
        }
      }
    },
    after(tree) {
      const live = new Set<string>()
      for (const node of wrappedNodes(tree)) {
        live.add(node.key)
        const slot = slots.get(node.key)
        const page = slot?.page
        if (slot === undefined || page === undefined || slot.entry === undefined) continue
        if (node.hidden) {
          if (!slot.parked) {
            if (slot.shown) remember(slot)
            if (!slot.hid) fire(slot, true)
            slot.next = page.nextSibling
            page.remove()
            slot.parked = true
          }
          slot.shown = false
          continue
        }
        unpark(slot)
        if (slot.showing) {
          slot.showing = false
          for (const [element, top, left] of slot.offsets ?? []) {
            if (!page.contains(element)) continue
            element.scrollTop = top
            element.scrollLeft = left
          }
          const focus = slot.focus
          if (focus?.isConnected && page.contains(focus))
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: it held focus, so it is focusable; the call stays optional
            (focus as HTMLElement).focus?.({ preventScroll: true })
          fire(slot, false)
        }
        slot.offsets = undefined
        slot.focus = undefined
        if (!slot.shown && !slot.checked) {
          slot.checked = true
          if (typeof process !== "undefined" && process.env.NODE_ENV !== "production")
            checkSlotCss(slot.entry, page)
        }
        slot.shown = true
      }
      for (const key of [...slots.keys()]) {
        if (live.has(key)) continue
        slots.delete(key)
        entryRefs.delete(key)
        pageRefs.delete(key)
        if (typeof process !== "undefined" && process.env.NODE_ENV !== "production")
          noteKeptView(key, undefined)
      }
    },
  }
}

// The selectors already reported, once per document.
const reportedCss = new Set<string>()
// Pseudo-classes that read an element's position among its siblings, which the wrappers change.
const POSITIONAL =
  /:(?:first-child|last-child|only-child|nth-child\([^)]*\)|nth-last-child\([^)]*\))/g
const DIRECT_HAS = /:has\(\s*>\s*([^)]*)\)/

/** `selector`'s compounds and the combinators between them, split outside parentheses and brackets. */
const compoundsOf = (
  selector: string,
): { readonly compound: string; readonly before: string }[] => {
  const parts: { compound: string; before: string }[] = []
  let depth = 0
  let start = 0
  let combinator = ""
  const flush = (end: number): void => {
    const compound = selector.slice(start, end).trim()
    if (compound !== "") {
      parts.push({ compound, before: combinator })
      combinator = ""
    }
  }
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i]
    if (char === "(" || char === "[") depth++
    else if (char === ")" || char === "]") depth--
    if (depth > 0 || (char !== " " && char !== ">" && char !== "+" && char !== "~")) continue
    flush(i)
    if (char !== " ") combinator = char
    else if (combinator === "") combinator = " "
    start = i + 1
  }
  if (depth <= 0) flush(selector.length)
  return parts
}

const matches = (element: Element, selector: string): boolean => {
  try {
    return element.matches(selector)
  } catch {
    return false
  }
}

// Whether `selector` targets a top-level node of the page as a child of the element the slot sits in,
// which the two wrappers between them now break.
const breaksAround = (selector: string, parent: Element, tops: readonly Element[]): boolean => {
  const parts = compoundsOf(selector)
  for (const [i, { compound, before }] of parts.entries()) {
    const prefix = parts
      .slice(0, i)
      .map((part, j) => (j === 0 ? part.compound : `${part.before} ${part.compound}`))
      .join(" ")
    if (before === ">" && matches(parent, prefix) && tops.some((top) => matches(top, compound)))
      return true
    if (POSITIONAL.test(compound)) {
      POSITIONAL.lastIndex = 0
      const rest = compound.replace(POSITIONAL, "") || "*"
      if (
        tops.some((top) => matches(top, rest)) &&
        (prefix === "" || matches(parent, prefix) || parent.closest(prefix) !== null)
      )
        return true
    }
    POSITIONAL.lastIndex = 0
    const has = DIRECT_HAS.exec(compound)
    if (has !== null) {
      const owner = compound.replace(DIRECT_HAS, "") || "*"
      if (matches(parent, owner) && tops.some((top) => matches(top, has[1] ?? ""))) return true
    }
  }
  return false
}

const scanRules = (
  rules: CSSRuleList,
  parent: Element,
  tops: readonly Element[],
  source: string,
): void => {
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) {
      for (const selector of splitSelectors(rule.selectorText)) {
        if (reportedCss.has(selector) || !breaksAround(selector, parent, tops)) continue
        reportedCss.add(selector)
        console.warn(
          `[nifra/web] NIFRA_KEEPALIVE_DIRECT_CHILD_CSS: the selector "${selector}"${source} reaches a kept page's top-level element as a direct child of <${parent.tagName.toLowerCase()}>, but a keepAlive page renders inside two display:contents wrappers, so it no longer matches. Use a descendant combinator, target the wrapper ([data-nifra-page] > ...), or put a class on the page's root element.`,
        )
      }
    } else if ("cssRules" in rule) {
      // @media, @supports, @layer and @container rules hold style rules of their own.
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a rule with cssRules is a grouping rule
      scanRules((rule as CSSGroupingRule).cssRules, parent, tops, source)
    }
  }
}

const splitSelectors = (list: string): string[] => {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const char = list[i]
    if (char === "(" || char === "[") depth++
    else if (char === ")" || char === "]") depth--
    else if (char === "," && depth === 0) {
      out.push(list.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(list.slice(start).trim())
  return out.filter((selector) => selector !== "")
}

/**
 * Dev only: report each same-origin style rule whose selector the slot wrappers around `page` stop
 * matching (`NIFRA_KEEPALIVE_DIRECT_CHILD_CSS`). A stylesheet the page cannot read is skipped.
 */
export function checkSlotCss(entry: Element, page: Element): void {
  const parent = entry.parentElement
  const tops = [...page.children]
  if (parent === null || tops.length === 0 || typeof document === "undefined") return
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    scanRules(rules, parent, tops, sheet.href === null ? "" : ` (${sheet.href})`)
  }
}
