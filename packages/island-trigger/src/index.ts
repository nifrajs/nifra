/**
 * @nifrajs/island-trigger - the tiny browser-side trigger primitive shared by Nifra's two island
 * runtimes. It knows scheduling and browser capability fallbacks, but it knows nothing about markers,
 * registries, signals, or UI frameworks.
 */

/** When an island's enhancer runs. An object strategy is intentionally limited to media queries. */
export type IslandStrategy = "load" | "idle" | "visible" | { readonly media: string }

/** The maximum media-query length accepted from an HTML data attribute. */
export const MAX_MEDIA_QUERY_LENGTH = 256

export interface TriggerOptions {
  /** Target used by the `visible` strategy. Missing targets degrade to immediate activation. */
  readonly target?: Element
}

const NOOP = (): void => {}

type MediaQueryListLike = {
  readonly matches: boolean
  addEventListener?: (type: "change", listener: (event: MediaQueryListEvent) => void) => void
  removeEventListener?: (type: "change", listener: (event: MediaQueryListEvent) => void) => void
  addListener?: (listener: (event: MediaQueryListEvent) => void) => void
  removeListener?: (listener: (event: MediaQueryListEvent) => void) => void
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
  let fired = false
  let disposed = false
  let cleanup: (() => void) | undefined

  const fire = (): void => {
    if (fired || disposed) return
    fired = true
    cleanup?.()
    cleanup = undefined
    run()
  }

  if (strategy === "load") {
    fire()
    return NOOP
  }

  if (strategy === "idle") {
    const ric = globalThis.requestIdleCallback
    if (ric === undefined) {
      const handle = globalThis.setTimeout(fire, 1)
      return () => {
        disposed = true
        globalThis.clearTimeout(handle)
      }
    }
    const handle = ric(fire)
    return () => {
      disposed = true
      globalThis.cancelIdleCallback?.(handle)
    }
  }

  if (strategy === "visible") {
    if (options.target === undefined || typeof IntersectionObserver === "undefined") {
      fire()
      return NOOP
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) fire()
    })
    observer.observe(options.target)
    cleanup = () => observer.disconnect()
    return () => {
      disposed = true
      cleanup?.()
      cleanup = undefined
    }
  }

  const query = mediaQuery(strategy)
  const matchMedia = (
    globalThis as typeof globalThis & {
      matchMedia?: (query: string) => MediaQueryListLike
    }
  ).matchMedia
  if (query === undefined) return NOOP
  if (matchMedia === undefined) {
    // No matchMedia means the browser cannot honor a conditional trigger. Immediate activation is
    // the availability fallback; malformed/oversized queries remain inert above.
    fire()
    return NOOP
  }

  const list = matchMedia(query)
  if (list.matches) {
    fire()
    return NOOP
  }

  const onChange = (event: MediaQueryListEvent): void => {
    if (event.matches) fire()
  }
  if (list.addEventListener !== undefined) {
    list.addEventListener("change", onChange)
    cleanup = () => list.removeEventListener?.("change", onChange)
  } else if (list.addListener !== undefined) {
    list.addListener(onChange)
    cleanup = () => list.removeListener?.(onChange)
  } else {
    return NOOP
  }
  return () => {
    disposed = true
    cleanup?.()
    cleanup = undefined
  }
}
