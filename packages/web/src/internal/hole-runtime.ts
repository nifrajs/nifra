/**
 * The browser side of a partially prerendered page's holes, shared by every adapter's `Hole`: the
 * host's first fill from the document, and each refill a data request brings when the page on screen
 * reloads. An adapter supplies only how an interactive hole's own root hydrates, updates and goes. A
 * hole that shows a server component mounts the client islands inside it through the component
 * client the app registered with `holeComponents` (`@nifrajs/web/server-components/client`).
 */
import type { ComponentClientAdapter, ComponentClientRoot } from "../server-components/client.ts"
import type { ComponentRecord } from "../server-components/types.ts"
import { onPageRelease, PAGE_HIDE_EVENT, PAGE_SHOW_EVENT } from "./page-events.ts"
import { isRecord } from "./record.ts"

/** One hole's fill, as the PPR runtime keeps it. */
export interface HoleFill {
  readonly props?: unknown
  readonly error: boolean
  /** The record of the server component the hole shows, without its HTML. */
  readonly component?: unknown
  /** That component's HTML. */
  readonly html?: string
}

/** The slice of a boundary state a hole reads: `ppr` marks a hole the shared shell left open, and
 * `fill` that host's refill when the page reloads. */
export interface HoleState {
  readonly status: "unresolved" | "pending" | "ready" | "error"
  readonly data?: unknown
  readonly ppr?: true
  readonly fill?: unknown
}

/** The shell's inline runtime (internal/ppr/runtime.ts). */
interface PprRuntime {
  get(name: string): HoleFill | undefined
  subscribe(name: string, callback: (fill: HoleFill) => void): () => void
  put(name: string, frame: unknown, host: Element): void
  /** Stop filling holes from the document, and cancel the ones still loading on the server. */
  leave?(): void
}

/** The error slot a failed, timed-out or refused hole shows. Constant: no thrown message reaches it. */
export const HOLE_ERROR_HTML = '<p data-nifra-hole-error="">This section is unavailable.</p>'

const ERROR_FRAME = { v: 1, error: true, html: HOLE_ERROR_HTML } as const

/** The runtime the shell's inline script defines, when this document has one. */
const pprRuntime = (): PprRuntime | undefined => {
  const runtime: unknown = Reflect.get(globalThis, "__nifraPpr")
  return typeof runtime === "function" &&
    "get" in runtime &&
    "subscribe" in runtime &&
    "put" in runtime
    ? // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the shell's constant inline runtime defines exactly this shape.
      (runtime as PprRuntime)
    : undefined
}

/** How the islands inside a hole that shows a server component mount: the app's component client,
 * and the protocol check the component's record passes first. */
export interface HoleComponents {
  readonly client: ComponentClientAdapter
  record(value: unknown): ComponentRecord
}

let components: HoleComponents | undefined

/** What `holeComponents` registers; `undefined` forgets it. */
export function setHoleComponents(next: HoleComponents | undefined): void {
  components = next
}

/** An interactive hole's own root, as its adapter made it. */
export interface HoleRoot {
  /** Render new props into the root, keeping its state; `false` when it has to be made again. */
  update(props: unknown): boolean
  /** `leaving`: the page is unmounting the host, so the adapter may defer the work. A promise means
   * the host is not free until it settles. */
  dispose(leaving: boolean): void | Promise<void>
  /** The kept page holding the host is hidden (`true`) or shown again: a root whose framework can
   * pause what it runs keeps its state either way. */
  hide?(hidden: boolean): void
}

export interface HoleHost {
  /** Apply a data request's fill once it arrives, unless a newer one is given first. Without the
   * shell's runtime, only a server component's fill or the error slot can be put. A first fill the
   * host was rendered with (`initialHtml`) hydrates its islands over that HTML. */
  refill(fill: unknown): void
  dispose(): void
  /**
   * For an adapter whose hidden page cleans its effects up (React's `Activity`): while a kept page
   * hides the host, keep it, root and all, for the page's return, and dispose it only if the page is
   * dropped. `false` when nothing hides the host, and disposing is the adapter's.
   */
  park(): boolean
  /** The parked host is the adapter's again. */
  unpark(): void
}

/** A fill the server deferred: the NDJSON stream settles its promise. */
const settledFill = (fill: unknown): Promise<unknown> =>
  isRecord(fill) && fill.__nifra_deferred === true && fill.promise instanceof Promise
    ? fill.promise
    : Promise.resolve(fill)

/**
 * What a host renders with: a blocking render's settled fill puts the server's HTML in it, which a
 * crawler reads with no script; any other state leaves it empty. A host reads it once, so no later
 * render changes what the runtime put there.
 */
export const initialHtml = (fill: unknown): string =>
  isRecord(fill) && fill.__nifra_deferred !== true && typeof fill.html === "string" ? fill.html : ""

/** The record of the server component a fill shows, its HTML put back, not yet checked. */
const recordOf = (fill: Record<string, unknown>): Record<string, unknown> | undefined =>
  isRecord(fill.component) && typeof fill.html === "string"
    ? { ...fill.component, html: fill.html }
    : undefined

/** The error slot, built without HTML parsing, for a document with no runtime to put it. */
const errorSlot = (host: Element): void => {
  const slot = host.ownerDocument.createElement("p")
  slot.setAttribute("data-nifra-hole-error", "")
  slot.textContent = "This section is unavailable."
  host.replaceChildren(slot)
  host.setAttribute("data-nifra-hole-error", "")
}

/**
 * The islands of the server component in `host`: hydrated over the server's HTML, or with `fresh`,
 * put into the host from the record. `failed` runs when they cannot mount, as when the record fails
 * the protocol check.
 */
function componentRoot(
  host: Element,
  unchecked: Record<string, unknown>,
  fresh: boolean,
  failed: () => void,
): HoleRoot {
  const registered = components
  let current = true
  const valid = (): boolean => current
  const mounted: Promise<ComponentClientRoot | undefined> = (async () => {
    if (registered === undefined) {
      throw new Error(
        "[nifra/web] ppr: a hole shows a server component, but no holeComponents client",
      )
    }
    const { client } = registered
    const record = registered.record(unchecked)
    const mount = fresh ? client.create : client.hydrate
    if (mount === undefined) throw new Error("[nifra/web] ppr: the component client cannot create")
    const prepared = await client.prepare(record, valid, host, { records: [record] })
    if (!current) return undefined
    const root = await mount.call(client, host, record, prepared, valid)
    if (!current) {
      await root.dispose()
      return undefined
    }
    host.setAttribute("aria-busy", "false")
    return root
  })().catch((error: unknown) => {
    if (current) {
      console.error("[nifra/web] ppr: a server component hole's islands did not mount", error)
      failed()
    }
    return undefined
  })
  return {
    update: () => false,
    dispose() {
      current = false
      return mounted.then((root) => root?.dispose())
    },
  }
}

/**
 * Drive the host of hole `name`. `hydrate` makes an interactive hole's root over the server HTML in
 * `host`; a hole without one only ever shows server HTML, or a server component's.
 */
export function holeHost(
  name: string,
  host: Element,
  hydrate: ((host: Element, props: unknown) => HoleRoot) | undefined,
): HoleHost {
  const runtime = pprRuntime()
  let root: HoleRoot | undefined
  let disposed = false
  let latest = 0
  // The kept page hiding the host, and what disposes the host if that page is dropped.
  let hiddenBy: Element | undefined
  let release: (() => void) | undefined
  const put = (frame: Record<string, unknown>): void => {
    if (runtime !== undefined) runtime.put(name, frame, host)
    else errorSlot(host)
    host.setAttribute("aria-busy", "false")
  }
  const showError = (): void => {
    root = undefined
    put(ERROR_FRAME)
  }
  const start = (fill: HoleFill): void => {
    if (disposed || root !== undefined || fill.error) return
    const record = recordOf({ component: fill.component, html: fill.html })
    if (record !== undefined) root = componentRoot(host, record, false, showError)
    else if (hydrate !== undefined) root = hydrate(host, fill.props)
  }
  const now = runtime?.get(name)
  const unsubscribe =
    now === undefined && (hydrate !== undefined || components !== undefined)
      ? runtime?.subscribe(name, start)
      : undefined
  if (now !== undefined) start(now)
  // A `keepAlive` page hidden behind another has been left: the document's holes stop filling and
  // the ones still loading are cancelled, and a refill already on its way is dropped. The page's
  // reload when it is shown again refills the host.
  const hidden = (event: Event): void => {
    if (!(event.target instanceof Element) || !event.target.contains(host)) return
    hiddenBy = event.target
    latest++
    runtime?.leave?.()
    root?.hide?.(true)
  }
  const shown = (event: Event): void => {
    if (event.target !== hiddenBy) return
    hiddenBy = undefined
    root?.hide?.(false)
  }
  host.ownerDocument.addEventListener(PAGE_HIDE_EVENT, hidden)
  host.ownerDocument.addEventListener(PAGE_SHOW_EVENT, shown)
  const apply = (frame: unknown, mine: number, inPlace: boolean): void => {
    if (!isRecord(frame)) return
    const failed = frame.error === true
    const record = failed ? undefined : recordOf(frame)
    if (!failed && record === undefined && root?.update(frame.props) === true) {
      host.setAttribute("aria-busy", "false")
      return
    }
    // An error shows the error slot, never content the action that reloaded it may have changed.
    const gone = root?.dispose(false)
    root = undefined
    const fill = (): void => {
      if (disposed || mine !== latest) return
      host.removeAttribute("data-nifra-hole-error")
      if (record !== undefined) {
        host.setAttribute("data-nifra-filled", "")
        root = componentRoot(host, record, !inPlace, showError)
        return
      }
      put(frame)
      if (!failed && hydrate !== undefined) root = hydrate(host, frame.props)
    }
    if (gone instanceof Promise) gone.then(fill, fill)
    else fill()
  }
  const dispose = (): void => {
    disposed = true
    release?.()
    release = undefined
    host.ownerDocument.removeEventListener(PAGE_HIDE_EVENT, hidden)
    host.ownerDocument.removeEventListener(PAGE_SHOW_EVENT, shown)
    unsubscribe?.()
    Promise.resolve(root?.dispose(true)).catch(() => {})
    root = undefined
  }
  return {
    refill(fill) {
      // A blocking render's settled fill is the server HTML the host already shows.
      const inPlace = latest === 0 && root === undefined && initialHtml(fill) !== ""
      const mine = ++latest
      host.setAttribute("aria-busy", "true")
      settledFill(fill).then(
        (frame) => {
          if (!disposed && mine === latest) apply(frame, mine, inPlace)
        },
        () => {
          if (!disposed && mine === latest) apply(ERROR_FRAME, mine, false)
        },
      )
    },
    dispose,
    park() {
      if (disposed || hiddenBy === undefined) return false
      release ??= onPageRelease(hiddenBy, dispose)
      return true
    },
    unpark() {
      release?.()
      release = undefined
    },
  }
}
