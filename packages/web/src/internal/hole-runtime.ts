/**
 * The browser side of a partially prerendered page's holes, shared by every adapter's `Hole`: the
 * host's first fill from the document, and each refill a data request brings when the page on screen
 * reloads. An adapter supplies only how an interactive hole's own root hydrates, updates and goes.
 */

/** One hole's fill, as the PPR runtime keeps it. */
export interface HoleFill {
  readonly props?: unknown
  readonly error: boolean
}

/** The shell's inline runtime (internal/ppr/runtime.ts). */
interface PprRuntime {
  get(name: string): HoleFill | undefined
  subscribe(name: string, callback: (fill: HoleFill) => void): () => void
  put(name: string, frame: unknown, host: Element): void
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

/** An interactive hole's own root, as its adapter made it. */
export interface HoleRoot {
  /** Render new props into the root, keeping its state; `false` when it has to be made again. */
  update(props: unknown): boolean
  /** `leaving`: the page is unmounting the host, so the adapter may defer the work. */
  dispose(leaving: boolean): void
}

export interface HoleHost {
  /** Apply a data request's fill once it arrives, unless a newer one is given first. */
  refill(fill: unknown): void
  dispose(): void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** A fill the server deferred: the NDJSON stream settles its promise. */
const settledFill = (fill: unknown): Promise<unknown> =>
  isRecord(fill) && fill.__nifra_deferred === true && fill.promise instanceof Promise
    ? fill.promise
    : Promise.resolve(fill)

/**
 * Drive the host of hole `name`. `hydrate` makes an interactive hole's root over the server HTML in
 * `host`; a hole without one only ever shows server HTML. `undefined` when the document has no PPR
 * runtime, so nothing fills the host.
 */
export function holeHost(
  name: string,
  host: Element,
  hydrate: ((host: Element, props: unknown) => HoleRoot) | undefined,
): HoleHost | undefined {
  const runtime = pprRuntime()
  if (runtime === undefined) return undefined
  let root: HoleRoot | undefined
  let disposed = false
  let latest = 0
  const start = (fill: HoleFill): void => {
    if (disposed || root !== undefined || fill.error || hydrate === undefined) return
    root = hydrate(host, fill.props)
  }
  const now = runtime.get(name)
  const unsubscribe =
    now === undefined && hydrate !== undefined ? runtime.subscribe(name, start) : undefined
  if (now !== undefined) start(now)
  const apply = (frame: unknown): void => {
    if (!isRecord(frame)) return
    const failed = frame.error === true
    if (!failed && root?.update(frame.props) === true) {
      host.setAttribute("aria-busy", "false")
      return
    }
    // An error shows the error slot, never content the action that reloaded it may have changed.
    root?.dispose(false)
    root = undefined
    runtime.put(name, frame, host)
    if (!failed && hydrate !== undefined) root = hydrate(host, frame.props)
  }
  return {
    refill(fill) {
      const mine = ++latest
      host.setAttribute("aria-busy", "true")
      settledFill(fill).then(
        (frame) => {
          if (!disposed && mine === latest) apply(frame)
        },
        () => {
          if (!disposed && mine === latest) apply(ERROR_FRAME)
        },
      )
    },
    dispose() {
      disposed = true
      unsubscribe?.()
      root?.dispose(true)
      root = undefined
    },
  }
}
