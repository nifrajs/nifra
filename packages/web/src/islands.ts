/**
 * @nifrajs/web/islands — the framework-agnostic islands client runtime.
 *
 * An "island" is a server-rendered `<nifra-island>` element whose interactivity is mounted by a small
 * **plain-DOM** enhancer instead of a framework runtime. On a route that opts out of full-document
 * hydration (`export const hydrate = false`), the page ships **zero** framework JS; only the island
 * bundle (this runtime + your enhancers) loads. This variant ships ~99% less client JS than full
 * React hydration on a mostly-static page — the framework runtime is the cost, and islands skip it
 * entirely here.
 *
 * Server side: render the marker with `@nifrajs/web-react`'s `<Island>` (or any framework's host element
 * `<nifra-island data-id data-strategy data-props>`). Props are JSON-encoded inline in `data-props`
 * (attribute-escaped by the framework) — no central registry, so concurrent SSR renders never share
 * state. Client side: bundle one entry that calls `mountIslands({ <id>: enhancer })` and load it via
 * the route's `islandScripts`.
 */

/** When an island's enhancer runs. Default `load`. */
export type IslandStrategy = "load" | "idle" | "visible"

/** Optional teardown an enhancer returns (remove listeners/observers); run on `dispose()`. */
export type IslandCleanup = () => void

/**
 * Enhances one island element with its (typed) props. Return a cleanup function to tear down on
 * `dispose()` (listeners, observers) — optional; an enhancer with nothing to clean up returns nothing.
 * The `void` member is the no-cleanup case, the same shape as React's `EffectCallback`.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` = "no cleanup returned", like React's EffectCallback — cleanup is optional.
export type IslandEnhancer<P = unknown> = (el: HTMLElement, props: P) => IslandCleanup | void

const NOOP = (): void => {}

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

/** Run `run` per the island's strategy; returns a disposer that cancels a not-yet-fired trigger. */
function whenStrategy(el: HTMLElement, strategy: IslandStrategy, run: () => void): () => void {
  if (strategy === "idle") {
    const ric = globalThis.requestIdleCallback
    if (ric === undefined) {
      const t = setTimeout(run, 1)
      return () => clearTimeout(t)
    }
    const handle = ric(run)
    return () => globalThis.cancelIdleCallback?.(handle)
  }
  if (strategy === "visible") {
    // No IntersectionObserver (old engine / SSR smoke) → degrade to immediate, never skip the island.
    if (typeof IntersectionObserver === "undefined") {
      run()
      return NOOP
    }
    const io = new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          obs.disconnect()
          run()
          return
        }
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }
  // "load" (and any unknown value) → run immediately on mount.
  run()
  return NOOP
}

/**
 * Find every `<nifra-island data-id>` under `root` (default `document`) and enhance each with the
 * matching enhancer, honoring its `data-strategy`. An island whose `id` has no enhancer is left as
 * inert SSR HTML (forward-compatible). An enhancer that throws is isolated — it never blocks the
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
    const strategy: IslandStrategy =
      strategyAttr === "idle" || strategyAttr === "visible" ? strategyAttr : "load"
    const run = (): void => {
      try {
        const cleanup = enhancer(el, props)
        if (typeof cleanup === "function") disposers.push(cleanup)
      } catch (err) {
        // One island's failure must not take down the others; surface it without throwing.
        console.error(`[nifra/islands] enhancer "${id}" failed:`, err)
      }
    }
    disposers.push(whenStrategy(el, strategy, run))
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // best-effort teardown — a failing cleanup must not block the rest
      }
    }
  }
}
