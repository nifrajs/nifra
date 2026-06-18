/**
 * Islands: named interactive regions inside server-rendered pages. The server marks a host —
 *
 *   <section data-island="compare" data-island-state='{"count":2,"max":4}'>
 *     <span data-bind-text="count">2</span>
 *     <button data-bind-on="click:add">Add</button>
 *   </section>
 *
 * — and the client registers behavior by name. `state(key, fallback)` returns a signal seeded
 * from the host's `data-island-state` JSON: the server's loader data becomes client signals with
 * zero extra serialization ceremony (the attribute IS the wire format; `@nifrajs/web-vanilla`'s
 * escaping makes it safe to emit).
 */

import { type BindableElement, type BindableRoot, bindScope, type IslandScope } from "./bind.ts"
import type { Signal } from "./signals.ts"
import { signal } from "./signals.ts"

export interface IslandContext {
  /** The island's host element. */
  readonly root: BindableElement & BindableRoot
  /**
   * A named signal, seeded from `data-island-state`'s value for `key` when present, else
   * `fallback`. Each key returns the SAME signal across calls — bindings and setup share state.
   */
  state<T>(key: string, fallback: T): Signal<T>
}

/** An island's setup function: read/seed state, return the event handlers the markup names. */
export type IslandSetup = (ctx: IslandContext) => Record<string, (event: Event) => void> | undefined

const registry = new Map<string, IslandSetup>()

/** Register an island's behavior by name (the markup's `data-island` value). */
export function island(name: string, setup: IslandSetup): void {
  registry.set(name, setup)
}

/** The host-element surface `mountIslands` needs beyond bindings. */
export interface IslandHost extends BindableElement, BindableRoot {
  setAttribute(name: string, value: string): void
}

/**
 * Mount every registered island under `root` (default: the document). Idempotent — a host is
 * marked once mounted, so calling again (e.g. after a soft navigation swapped content in) only
 * mounts new hosts. Unregistered island names are skipped silently: markup may ship ahead of
 * its script, and progressive enhancement means the static content is already correct.
 */
export function mountIslands(root: BindableRoot = document as unknown as BindableRoot): void {
  for (const host of root.querySelectorAll("[data-island]") as Iterable<IslandHost>) {
    if (host.getAttribute("data-island-mounted") !== null) continue
    const name = host.getAttribute("data-island") ?? ""
    const setup = registry.get(name)
    if (setup === undefined) continue
    host.setAttribute("data-island-mounted", "")

    // Seed state from the host's JSON attribute. Malformed JSON is a server bug — fail loud in
    // the console, mount with fallbacks only (the static markup stays usable).
    let seeded: Record<string, unknown> = {}
    const rawState = host.getAttribute("data-island-state")
    if (rawState !== null && rawState !== "") {
      try {
        const parsed: unknown = JSON.parse(rawState)
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          seeded = parsed as Record<string, unknown>
        } else {
          console.error(`[nifra/islets] data-island-state on "${name}" must be a JSON object`)
        }
      } catch {
        console.error(`[nifra/islets] malformed data-island-state JSON on island "${name}"`)
      }
    }

    const signals: Record<string, Signal<unknown>> = {}
    const ctx: IslandContext = {
      root: host,
      state<T>(key: string, fallback: T): Signal<T> {
        const existing = signals[key]
        if (existing !== undefined) return existing as Signal<T>
        const initial = Object.hasOwn(seeded, key) ? (seeded[key] as T) : fallback
        const s = signal<T>(initial)
        signals[key] = s as Signal<unknown>
        return s
      },
    }
    const handlers = setup(ctx) ?? {}
    const scope: IslandScope = { signals, handlers }
    bindScope(host, scope)
  }
}

/**
 * Server-side helper: the value for a host's `data-island-state` attribute. Plain JSON — emit it
 * through an escaping renderer (`@nifrajs/web-vanilla`'s `html` escapes quotes in attributes), e.g.
 * `html\`<div data-island="compare" data-island-state="${islandState({ count })}">…\``.
 */
export function islandState(state: Record<string, unknown>): string {
  return JSON.stringify(state)
}
