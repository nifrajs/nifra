/**
 * @nifrajs/web-svelte — the Svelte 5 render adapter for @nifrajs/web (server side) + the `.svelte` compiler
 * Bun-plugin. SSR via Svelte's `render` (svelte/server), which returns HTML strings (Svelte SSR is
 * string-based, not a stream), wrapped in a one-chunk Web `ReadableStream` (the seam's shape). The
 * layout-chain fold is the recursive `Chain.svelte`. Client hydration lives in `@nifrajs/web-svelte/client`.
 * Svelte components compile from `.svelte` files, so this adapter ships a build plugin (like
 * `@nifrajs/web-solid`'s Babel plugin) — there is no callable-component runtime.
 */
import type { RenderAdapter } from "@nifrajs/web"
import { render } from "svelte/server"
import Chain from "./Chain.svelte"

// Re-export the compiler plugin for convenience. NOTE: the SSR preload must import it from
// `@nifrajs/web-svelte/plugin` (not from here) — importing this module eagerly loads `Chain.svelte`,
// which must be compiled by the already-registered plugin.
export { svelteBunPlugin } from "./plugin.ts"

// Svelte SSR yields a complete HTML string; the seam wants a stream, so emit it as one chunk.
function oneChunk(html: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(html)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** The Svelte server render adapter — pass to @nifrajs/web's `renderPage`. */
export const svelteAdapter: RenderAdapter = {
  // Svelte SSR is already synchronous + string-based, so this is the native shape: `renderToString`
  // returns the body directly (renderPage buffers it on the non-deferred fast path), and
  // `renderToStream` wraps the same string in a one-chunk stream for the deferred path. No streaming
  // renderer to skip here — but going straight to a string avoids the per-request stream allocation.
  renderToString(chain, props) {
    return render(Chain, { props: { chain, props, layoutData: props.layoutData } }).body
  },
  renderToStream(chain, props) {
    // `Chain` folds the layout chain (page innermost gets `props`; layouts wrap via their `children`
    // snippet). Svelte's `render` returns { head, body }; the body goes into #root. (Svelte's dynamic
    // `head` — from <svelte:head> — isn't surfaced through the seam's static `hydrationHead`; nifra's
    // own meta/head API manages the document head instead.)
    const { body } = render(Chain, { props: { chain, props, layoutData: props.layoutData } })
    return oneChunk(body)
  },
  // Svelte's client `hydrate` reconciles against the existing DOM; no per-document bootstrap script is
  // needed (contrast Solid's generateHydrationScript) — the seam allows the empty string.
  hydrationHead() {
    return ""
  },
}
