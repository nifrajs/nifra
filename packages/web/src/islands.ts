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
