import {
  type IslandStrategy,
  MAX_MEDIA_QUERY_LENGTH,
  scheduleTrigger,
} from "@nifrajs/island-trigger"
import type { IslandCleanup, IslandEnhancer } from "../islands.ts"
import { owned } from "./island-owner.ts"

function readProps(el: HTMLElement): unknown {
  const raw = el.dataset.islandProps
  if (raw === undefined || raw === "") return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Own one host so removing a subtree can stop its islands without disturbing retained siblings. */
export function mountIsland(
  el: HTMLElement,
  enhancers: Readonly<Record<string, IslandEnhancer<never>>>,
): IslandCleanup | undefined {
  const id = el.dataset.island
  if (id === undefined || el.dataset.islandMounted !== undefined) return undefined
  const enhancer = Object.hasOwn(enhancers, id) ? enhancers[id] : undefined
  if (enhancer === undefined) return undefined
  const strategyAttr = el.dataset.islandStrategy
  const media = el.dataset.islandMedia
  const strategy: IslandStrategy | undefined =
    strategyAttr === "idle" || strategyAttr === "visible" || strategyAttr === "load"
      ? strategyAttr
      : strategyAttr === "media" &&
          media !== undefined &&
          media.length > 0 &&
          media.length <= MAX_MEDIA_QUERY_LENGTH
        ? { media }
        : strategyAttr === undefined
          ? "load"
          : undefined
  // Invalid markers must stay inert, including untrusted oversized media queries.
  if (strategy === undefined) return undefined
  const disposers: Array<() => void> = []
  el.dataset.islandMounted = ""
  disposers.push(() => {
    delete el.dataset.islandMounted
  })
  const props = readProps(el)
  const run = (): void => {
    try {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: enhancer props are the authored SSR contract, as in defineIsland
      const cleanup = owned(disposers, () => enhancer(el, props as never))
      if (typeof cleanup === "function") disposers.push(cleanup)
    } catch (err) {
      console.error(`[nifra/islands] enhancer "${id}" failed:`, err)
    }
  }
  disposers.push(scheduleTrigger(strategy, run, { target: el }))
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Best-effort teardown: one failing cleanup must not block the rest.
      }
    }
  }
}
