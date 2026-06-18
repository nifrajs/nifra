/**
 * @nifrajs/islets — fine-grained signals + declarative DOM bindings for islands, in ~1 KB gz.
 *
 * The client companion to `@nifrajs/web-vanilla`: the server renders real HTML (zero framework
 * JS); islands attach behavior to it in place — no VDOM, no hydration re-render, no component
 * re-execution. Measured at ~0.47 KB gz vs ~4 KB for the smallest framework island; the
 * size budget is enforced by a test.
 *
 *   // server (any adapter; web-vanilla shown)
 *   html`<section data-island="compare" data-island-state="${islandState({ count: hotels.length })}">
 *     <span data-bind-text="count">${hotels.length}</span>
 *     <button data-bind-on="click:add" type="button">Compare</button>
 *   </section>`
 *
 *   // client island module (an `islandScripts` entry)
 *   import { island, mountIslands } from "@nifrajs/islets"
 *   island("compare", ({ state }) => {
 *     const count = state("count", 0)
 *     return { add: () => count.set((n) => n + 1) }
 *   })
 *   mountIslands()
 */

export {
  type BindableElement,
  type BindableRoot,
  bindScope,
  type IslandScope,
} from "./bind.ts"
export {
  type IslandContext,
  type IslandHost,
  type IslandSetup,
  island,
  islandState,
  mountIslands,
} from "./island.ts"
export { batch, computed, effect, type Signal, signal } from "./signals.ts"
