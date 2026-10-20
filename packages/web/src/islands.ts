/**
 * @nifrajs/web/islands - the islands client runtime: interactivity for server-rendered pages without a
 * framework runtime.
 *
 * An island is a server-rendered element marked `data-island="<id>"`. Its interactivity is mounted by
 * an enhancer instead of hydration, so on a route with `export const hydrate = false` the page ships
 * no framework JS; only the island bundle (this runtime + your enhancers) loads via `islandScripts`.
 *
 * Two tiers, one mount:
 *   - `defineIsland((el, props) => cleanup)` - plain DOM code. The default.
 *   - `bindIsland(({ state, onDispose }) => handlers)` - signals the markup binds by name through a
 *     closed set of `data-bind-*` attributes. No expression language: names only.
 * `signal`/`computed`/`effect`, a keyed `bindList` and an async `resource` work inside either tier;
 * whatever an enhancer creates stops when its island unmounts.
 *
 * Server side: `<div data-island="counter" data-island-props="${islandProps({ start: 0 })}">`, or
 * `@nifrajs/web-react`'s `<Island>`. Optional `data-island-strategy` (`load` | `idle` | `visible` |
 * `media`, with `data-island-media`). Props travel as JSON in the attribute - no central registry, so
 * concurrent SSR renders never share state. Nothing inside a `data-island-ignore` element mounts or
 * binds: render user HTML there.
 */

import {
  type IslandStrategy,
  MAX_MEDIA_QUERY_LENGTH,
  scheduleTrigger,
} from "@nifrajs/island-trigger"
import { bindScope, type IslandScope } from "./internal/island-bindings.ts"
import { owned } from "./internal/island-owner.ts"
import { type Signal, signal } from "./internal/island-signals.ts"

export {
  type BindListOptions,
  bindList,
  type ListContainer,
  type ListNode,
} from "./internal/island-list.ts"
export { type Resource, type ResourceState, resource } from "./internal/island-resource.ts"
export {
  batch,
  type Computed,
  computed,
  effect,
  type Signal,
  signal,
  untrack,
} from "./internal/island-signals.ts"
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
 * to pin the props shape so `el` and `props` are typed inside the body and the enhancer is
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
 * The props type is a contract, not a validator - `data-island-props` is JSON authored by your own
 * SSR, so it is trusted framing, not user input. Keep the enhancer body imperative: read the DOM,
 * wire listeners, return cleanup.
 */
export function defineIsland<P = unknown>(enhancer: IslandEnhancer<P>): IslandEnhancer<P> {
  return enhancer
}

/** What a `bindIsland` setup receives. */
export interface BindIslandContext<P> {
  /** The island's host element. */
  readonly root: HTMLElement
  /** The parsed `data-island-props`, or `undefined` when absent or malformed. */
  readonly props: P
  /**
   * The signal the markup binds as `key`, seeded from `props[key]` when present, else `fallback`.
   * Each key returns the same signal across calls.
   */
  state<T>(key: string, fallback: T): Signal<T>
  /** Run `fn` when the island unmounts - for timers, requests and listeners the setup starts. */
  onDispose(fn: () => void): void
}

/**
 * The binding tier: `setup` creates the island's state and returns the event handlers its markup
 * names; the island's `data-bind-*` attributes then bind them.
 *
 *   data-bind-text="count"   data-bind-show="open"   data-bind-class="active:open"
 *   data-bind-attr="aria-expanded:open"   data-bind-value="query"   data-bind-on="click:add"
 *
 * Attribute values are signal and handler names, never code; an unknown name warns once and the
 * server-rendered content stays as it is. A binding belongs to its nearest island.
 */
export function bindIsland<P = Record<string, unknown>>(
  setup: (ctx: BindIslandContext<P>) => Record<string, (event: Event) => void> | void,
): IslandEnhancer<P> {
  return (root, props) => {
    const stops: Array<() => void> = []
    const seeded: Record<string, unknown> = typeof props === "object" && props !== null ? props : {}
    // No prototype: a state key like `constructor` is an entry like any other.
    const signals: Record<string, Signal<unknown>> = Object.create(null)
    const ctx: BindIslandContext<P> = {
      root,
      props,
      state<T>(key: string, fallback: T): Signal<T> {
        signals[key] ??= signal(Object.hasOwn(seeded, key) ? seeded[key] : fallback)
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: each key's signal is created once, from this call's type
        return signals[key] as Signal<T>
      },
      onDispose: (fn) => {
        stops.push(fn)
      },
    }
    const scope: IslandScope = { signals, handlers: owned(stops, () => setup(ctx)) ?? {} }
    stops.push(...bindScope(root, scope))
    return () => {
      for (let stop = stops.pop(); stop !== undefined; stop = stops.pop()) stop()
    }
  }
}

/** The `data-island-props` value for `props`: JSON. Emit it through an escaping renderer. */
export function islandProps(props: Record<string, unknown>): string {
  return JSON.stringify(props)
}

/** Parse an island's inline `data-island-props` JSON; malformed/absent → `undefined` (never throws). */
function readProps(el: HTMLElement): unknown {
  const raw = el.dataset.islandProps
  if (raw === undefined || raw === "") return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * Find every `[data-island]` element under `root` (default `document`) and enhance each with the
 * matching enhancer, honoring its `data-island-strategy`. An island whose id has no enhancer, or that
 * is already mounted, is left alone, so calling again after a soft navigation mounts only new hosts.
 * An enhancer that throws is isolated - it never blocks the others. Every effect, list binding and
 * resource an enhancer creates is owned by its island. Returns a disposer that cancels pending
 * triggers and tears down every island it mounted (call it on soft-nav teardown).
 */
export function mountIslands(
  // `never` admits an enhancer of any props type: each one's props are its own island's JSON.
  enhancers: Readonly<Record<string, IslandEnhancer<never>>>,
  options: { readonly root?: ParentNode } = {},
): () => void {
  const root = options.root ?? document
  const disposers: Array<() => void> = []
  for (const el of root.querySelectorAll<HTMLElement>(
    "[data-island]:not([data-island-ignore],[data-island-ignore] *)",
  )) {
    const id = el.dataset.island
    if (id === undefined || el.dataset.islandMounted !== undefined) continue
    const enhancer = Object.hasOwn(enhancers, id) ? enhancers[id] : undefined
    if (enhancer === undefined) continue // no enhancer for this id → leave it as inert SSR markup
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
    // Invalid media markers remain inert rather than silently becoming eager. Their SSR content stays
    // usable, and untrusted HTML cannot turn an oversized query into an unexpected trigger.
    if (strategy === undefined) continue
    el.dataset.islandMounted = ""
    disposers.push(() => {
      delete el.dataset.islandMounted
    })
    const props = readProps(el)
    const run = (): void => {
      try {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: an enhancer's props type is a contract on its own server-rendered JSON, not a validator (see defineIsland)
        const cleanup = owned(disposers, () => enhancer(el, props as never))
        if (typeof cleanup === "function") disposers.push(cleanup)
      } catch (err) {
        // One island's failure must not take down the others; surface it without throwing.
        console.error(`[nifra/islands] enhancer "${id}" failed:`, err)
      }
    }
    disposers.push(scheduleTrigger(strategy, run, { target: el }))
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
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
