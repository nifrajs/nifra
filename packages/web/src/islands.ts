/**
 * @nifrajs/web/islands - the framework-agnostic islands client runtime.
 *
 * An "island" is a server-rendered `<nifra-island>` element whose interactivity is mounted by a small
 * **plain-DOM** enhancer instead of a framework runtime. On a route that opts out of full-document
 * hydration (`export const hydrate = false`), the page ships **zero** framework JS; only the island
 * bundle (this runtime + your enhancers) loads. This variant ships ~99% less client JS than full
 * React hydration on a mostly-static page - the framework runtime is the cost, and islands skip it
 * entirely here.
 *
 * Server side: render the marker with `@nifrajs/web-react`'s `<Island>` (or any framework's host element
 * `<nifra-island data-id data-strategy data-props>`). Props are JSON-encoded inline in `data-props`
 * (attribute-escaped by the framework) - no central registry, so concurrent SSR renders never share
 * state. Client side: bundle one entry that calls `mountIslands({ <id>: enhancer })` and load it via
 * the route's `islandScripts`.
 */

import {
  type IslandStrategy,
  MAX_MEDIA_QUERY_LENGTH,
  scheduleTrigger,
} from "@nifrajs/island-trigger"

export { type IslandStrategy, MAX_MEDIA_QUERY_LENGTH, scheduleTrigger }

/** Optional teardown an enhancer returns (remove listeners/observers); run on `dispose()`. */
export type IslandCleanup = () => void

/**
 * Enhances one island element with its (typed) props. Return a cleanup function to tear down on
 * `dispose()` (listeners, observers) - optional; an enhancer with nothing to clean up returns nothing.
 * The `void` member is the no-cleanup case, the same shape as React's `EffectCallback`.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` = "no cleanup returned", like React's EffectCallback - cleanup is optional.
export type IslandEnhancer<P = unknown> = (el: HTMLElement, props: P) => IslandCleanup | void

/**
 * Author a typed enhancer. Pure identity at runtime (zero cost, tree-shaken away) - its only job is
 * to pin the `data-props` shape so `el` and `props` are typed inside the body and the enhancer is
 * assignable to `mountIslands`. Prefer this over an inline arrow whenever an island reads props:
 *
 *   const counter = defineIsland<{ start: number }>((el, props) => {
 *     let n = props.start                       // props typed, no cast
 *     const out = el.querySelector("output")!
 *     const onClick = () => { out.textContent = String(++n) }
 *     el.querySelector("button")?.addEventListener("click", onClick)
 *     return () => el.querySelector("button")?.removeEventListener("click", onClick)
 *   })
 *   mountIslands({ counter })
 *
 * The props type is a contract, not a validator - `data-props` is JSON authored by your own SSR, so
 * it is trusted framing, not user input. Keep the enhancer body imperative: read the DOM, wire
 * listeners, return cleanup. No hidden reactivity to get wrong.
 */
export function defineIsland<P = unknown>(enhancer: IslandEnhancer<P>): IslandEnhancer<P> {
  return enhancer
}

/** Parse an island's inline `data-props` JSON; malformed/absent → `undefined` (never throws). */
function readProps(el: HTMLElement): unknown {
  const raw = el.dataset.props
  if (raw === undefined || raw === "") return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * Find every `<nifra-island data-id>` under `root` (default `document`) and enhance each with the
 * matching enhancer, honoring its `data-strategy`. An island whose `id` has no enhancer is left as
 * inert SSR HTML (forward-compatible). An enhancer that throws is isolated - it never blocks the
 * others (each island is independent). Returns a disposer that cancels pending triggers and runs every
 * enhancer's cleanup (call it on soft-nav teardown; harmless if your app never navigates).
 */
export function mountIslands(
  enhancers: Readonly<Record<string, IslandEnhancer>>,
  options: { readonly root?: ParentNode } = {},
): () => void {
  const root = options.root ?? document
  const disposers: Array<() => void> = []
  for (const el of root.querySelectorAll<HTMLElement>("nifra-island[data-id]")) {
    const id = el.dataset.id
    if (id === undefined) continue
    const enhancer = enhancers[id]
    if (enhancer === undefined) continue // no enhancer for this id → leave it as inert SSR markup
    const props = readProps(el)
    const strategyAttr = el.dataset.strategy
    const strategy: IslandStrategy | undefined =
      strategyAttr === "idle" || strategyAttr === "visible" || strategyAttr === "load"
        ? strategyAttr
        : strategyAttr === "media" &&
            el.dataset.media !== undefined &&
            el.dataset.media.length > 0 &&
            el.dataset.media.length <= MAX_MEDIA_QUERY_LENGTH
          ? { media: el.dataset.media }
          : strategyAttr === undefined
            ? "load"
            : undefined
    // Invalid media markers remain inert rather than silently becoming eager. Their SSR content stays
    // usable, and untrusted HTML cannot turn an oversized query into an unexpected trigger.
    if (strategy === undefined) continue
    const run = (): void => {
      try {
        const cleanup = enhancer(el, props)
        if (typeof cleanup === "function") disposers.push(cleanup)
      } catch (err) {
        // One island's failure must not take down the others; surface it without throwing.
        console.error(`[nifra/islands] enhancer "${id}" failed:`, err)
      }
    }
    disposers.push(scheduleTrigger(strategy, run, { target: el }))
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // best-effort teardown - a failing cleanup must not block the rest
      }
    }
  }
}

/** Unsubscribe one bus handler; calling twice is a no-op. Also returned so an enhancer can hand it
 * straight back as its `IslandCleanup`. */
export type IslandBusUnsubscribe = () => void

/**
 * A typed publish/subscribe channel for coordinating islands that must talk to each other without a
 * shared reactive store - a cart badge reacting to an "add to cart" island, a filter island driving
 * a results island. Create ONE bus in your mount entry and close over it in each enhancer; there is
 * no implicit global, so concurrent renders and tests never cross-talk.
 *
 *   type Events = { "cart:add": { sku: string }; "cart:count": number }
 *   const bus = createIslandBus<Events>()
 *   mountIslands({
 *     addBtn: defineIsland((el) => {
 *       const onClick = () => bus.emit("cart:add", { sku: el.dataset.sku! })
 *       el.addEventListener("click", onClick)
 *       return () => el.removeEventListener("click", onClick)
 *     }),
 *     badge: defineIsland((el) => bus.on("cart:count", (n) => { el.textContent = String(n) })),
 *   })
 *
 * `on` returns its own unsubscribe, so an enhancer whose only job is to listen can `return bus.on(...)`
 * directly as its cleanup. A handler that throws is isolated - it never blocks the other subscribers
 * or the `emit` caller. Synchronous, in-memory, no DOM dependency (safe to construct under SSR); it
 * carries no history, so a subscriber only sees events emitted after it subscribed.
 */
export function createIslandBus<
  Events extends Record<string, unknown> = Record<string, unknown>,
>(): {
  emit<K extends keyof Events>(type: K, detail: Events[K]): void
  on<K extends keyof Events>(type: K, handler: (detail: Events[K]) => void): IslandBusUnsubscribe
} {
  const channels = new Map<keyof Events, Set<(detail: never) => void>>()
  return {
    emit(type, detail) {
      const handlers = channels.get(type)
      if (handlers === undefined) return
      // Snapshot so a handler that (un)subscribes mid-dispatch cannot corrupt this iteration.
      for (const handler of [...handlers]) {
        try {
          ;(handler as (d: Events[typeof type]) => void)(detail)
        } catch (err) {
          console.error(`[nifra/islands] bus handler for "${String(type)}" failed:`, err)
        }
      }
    },
    on(type, handler) {
      let handlers = channels.get(type)
      if (handlers === undefined) {
        handlers = new Set()
        channels.set(type, handlers)
      }
      handlers.add(handler as (detail: never) => void)
      return () => {
        const set = channels.get(type)
        if (set === undefined) return
        set.delete(handler as (detail: never) => void)
        if (set.size === 0) channels.delete(type)
      }
    },
  }
}
