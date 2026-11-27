/**
 * @nifrajs/island-trigger - the tiny browser-side trigger primitive behind `@nifrajs/web/islands`.
 * It knows scheduling and browser capability fallbacks, but it knows nothing about markers,
 * registries, signals, or UI frameworks.
 */

/**
 * When an island's enhancer runs. `interaction` waits for the first hover, press, focus or click on
 * the island's own element. A click mounts during capture on the host. Listeners attached during
 * mount can receive the click at a descendant target or in the host's non-capture phase. An object
 * strategy is limited to media queries.
 */
export type IslandStrategy =
  | "load"
  | "idle"
  | "visible"
  | "interaction"
  | { readonly media: string }

// The earliest signals of intent: a pointer arriving, a press (touch included), keyboard focus. A
// click covers assistive technology that activates a control with no pointer or focus event first.
// A click mounts during capture on the host, so capture listeners added there during mount start
// with the next click.
const INTERACTION_EVENTS = ["pointerover", "pointerdown", "focusin", "click"] as const

/** The maximum media-query length accepted from an HTML data attribute. */
export const MAX_MEDIA_QUERY_LENGTH = 256

export interface TriggerOptions {
  /** Target used by the `visible` and `interaction` strategies. A missing target, or one that cannot
   * take listeners, degrades to immediate activation. */
  readonly target?: object
}

interface EventTargetLike {
  addEventListener?: (type: string, listener: () => void, capture: boolean) => void
  removeEventListener?: (type: string, listener: () => void, capture: boolean) => void
}

/** Structural event shape used instead of a DOM lib type so this package stays runtime-neutral. */
interface MediaQueryChangeEvent {
  readonly matches: boolean
}

interface IntersectionEntryLike {
  readonly isIntersecting: boolean
}

interface IntersectionObserverLike {
  observe(target: object): void
  disconnect(): void
}

interface BrowserCapabilities {
  readonly requestIdleCallback?: (callback: () => void) => number
  readonly cancelIdleCallback?: (handle: number) => void
  readonly matchMedia?: (query: string) => MediaQueryListLike
  readonly IntersectionObserver?: new (
    callback: (entries: readonly IntersectionEntryLike[]) => void,
  ) => IntersectionObserverLike
}

type MediaQueryListLike = {
  readonly matches: boolean
  addEventListener?: (type: "change", listener: (event: MediaQueryChangeEvent) => void) => void
  removeEventListener?: (type: "change", listener: (event: MediaQueryChangeEvent) => void) => void
  addListener?: (listener: (event: MediaQueryChangeEvent) => void) => void
  removeListener?: (listener: (event: MediaQueryChangeEvent) => void) => void
}

const mediaQuery = (strategy: IslandStrategy): string | undefined => {
  if (typeof strategy !== "object" || strategy === null) return undefined
  const query = strategy.media
  return query.length > 0 && query.length <= MAX_MEDIA_QUERY_LENGTH ? query : undefined
}

/**
 * Schedule an island trigger and return a disposer. Every successful trigger is one-shot: a late
 * media/visibility/idle event cannot run an enhancer twice. Invalid media strategies remain inert,
 * which keeps malformed untrusted HTML fail-closed while leaving its server-rendered content usable.
 */
export function scheduleTrigger(
  strategy: IslandStrategy,
  run: () => void,
  options: TriggerOptions = {},
): () => void {
  // Cast through unknown so a consumer's DOM lib cannot merge its stricter Element signatures into
  // this structural, DOM-free contract.
  const browser = globalThis as BrowserCapabilities
  let disposed = false
  let cleanup: (() => void) | undefined

  // The one disposer every pending strategy returns; `cleanup` holds what that strategy registered.
  const stop = (): void => {
    disposed = true
    cleanup?.()
    cleanup = undefined
  }
  // Firing stops the trigger first, so a late event (or a dispose) finds it already done.
  const fire = (): void => {
    if (disposed) return
    stop()
    run()
  }

  if (strategy === "load") {
    fire()
    return stop
  }

  if (strategy === "idle") {
    const ric = browser.requestIdleCallback
    if (ric === undefined) {
      const handle = setTimeout(fire, 1)
      cleanup = () => clearTimeout(handle)
    } else {
      const handle = ric(fire)
      cleanup = () => browser.cancelIdleCallback?.(handle)
    }
    return stop
  }

  if (strategy === "visible") {
    const Observer = browser.IntersectionObserver
    if (options.target === undefined || Observer === undefined) {
      fire()
      return stop
    }
    const observer = new Observer((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) fire()
    })
    observer.observe(options.target)
    cleanup = () => observer.disconnect()
    return stop
  }

  if (strategy === "interaction") {
    const target: EventTargetLike | undefined = options.target
    if (target?.addEventListener === undefined) {
      fire()
      return stop
    }
    for (const type of INTERACTION_EVENTS) target.addEventListener(type, fire, true)
    cleanup = () => {
      for (const type of INTERACTION_EVENTS) target.removeEventListener?.(type, fire, true)
    }
    return stop
  }

  const query = mediaQuery(strategy)
  const matchMedia = browser.matchMedia
  if (query === undefined) return stop
  if (matchMedia === undefined) {
    // No matchMedia means the browser cannot honor a conditional trigger. Immediate activation is
    // the availability fallback; malformed/oversized queries remain inert above.
    fire()
    return stop
  }

  const list = matchMedia(query)
  if (list.matches) {
    fire()
    return stop
  }

  const onChange = (event: MediaQueryChangeEvent): void => {
    if (event.matches) fire()
  }
  if (list.addEventListener !== undefined) {
    list.addEventListener("change", onChange)
    cleanup = () => list.removeEventListener?.("change", onChange)
  } else if (list.addListener !== undefined) {
    list.addListener(onChange)
    cleanup = () => list.removeListener?.(onChange)
  } else {
    return stop
  }
  return stop
}
