/**
 * @nifrajs/web-svelte - the Svelte 5 render adapter for @nifrajs/web (server side) + the `.svelte` compiler
 * Bun-plugin. SSR via Svelte's `render` (svelte/server), which returns HTML strings (Svelte SSR is
 * string-based, not a stream), wrapped in a one-chunk Web `ReadableStream` (the seam's shape). The
 * layout-chain fold is the recursive `Chain.svelte`. Client hydration lives in `@nifrajs/web-svelte/client`.
 * Svelte components compile from `.svelte` files, so this adapter ships a build plugin (like
 * `@nifrajs/web-solid`'s Babel plugin) - there is no callable-component runtime.
 */
import { fileURLToPath } from "node:url"
import type { RenderAdapter, RenderProps } from "@nifrajs/web"
import { ssrModuleLoader } from "@nifrajs/web"
import type { Component } from "svelte"
import { render as runtimeRender } from "svelte/server"

// Re-export the compiler plugin for convenience.
export { svelteBunPlugin } from "./plugin.ts"

/**
 * `Chain.svelte` is loaded on FIRST RENDER, not at module load.
 *
 * A static `import Chain from "./Chain.svelte"` here is unloadable in dev. The CLI's `loadApp` imports
 * the app's config, which re-exports this adapter, so this module evaluates before any Svelte compiler
 * is registered in the runtime - and a raw `.svelte` file then loads as a path string, so SSR dies at
 * render with `component is not a function`, naming the asset rather than the ordering. Bundled builds
 * never saw it: `Bun.build` compiles the whole graph up front.
 *
 * Deferring to first render moves the load AFTER the dev server has registered the app's
 * `serverPlugins`, which is the only point at which a compiler is guaranteed to exist.
 *
 * Exactly ONE render pays for that. `chain` is memoized as a plain value, so every later call takes the
 * synchronous branch below and allocates no promise - awaiting on the hot path measured as a real 3%
 * throughput loss on the SSR benchmark, which is not a price worth paying for a one-time import.
 */
/** What `Chain.svelte` destructures from `$props()`. */
interface ChainProps {
  readonly chain: readonly unknown[]
  readonly props: RenderProps
  /** Explicitly `| undefined`: the adapter always passes the key, and `RenderProps.layoutData` is
   * optional, so under `exactOptionalPropertyTypes` the absent case has to be part of the type. */
  readonly layoutData: readonly unknown[] | undefined
}
let chainComponent: Component<ChainProps> | undefined
let chainPromise: Promise<Component<ChainProps>> | undefined
/**
 * Svelte's server renderer. Normally the runtime's, but it is swapped for the dev server's copy when
 * `Chain` comes from there - a component compiled by one toolchain has to render through the renderer
 * that toolchain resolved, or `setContext` writes into a renderer the children never read.
 */
let render: typeof runtimeRender = runtimeRender
/** Resolved `Chain`, or the in-flight load on the very first call. */
const loadChain = (): Component<ChainProps> | Promise<Component<ChainProps>> => {
  if (chainComponent !== undefined) return chainComponent
  // A dev server that owns SSR resolution compiles the app's `.svelte` routes itself, and `Chain` has
  // to come from that same graph: the runtime has no `.svelte` loader on that pipeline, so a plain
  // `import` yields the file PATH and SSR dies at `component is not a function`. Registering a second
  // compiler in the runtime instead is the trap - it gives the tree two Svelte runtimes, and the
  // renderer `Chain` sets context on is not the one the routes read it from. Taking BOTH the component
  // and `svelte/server` from the dev server keeps it at one compiler and one runtime.
  const load = ssrModuleLoader()
  chainPromise ??= (
    load !== undefined
      ? Promise.all([
          load(fileURLToPath(new URL("./Chain.svelte", import.meta.url))),
          load("svelte/server"),
        ]).then(([mod, server]) => {
          render = (server as { render: typeof runtimeRender }).render
          return (mod as { default: Component<ChainProps> }).default
        })
      : import("./Chain.svelte").then((m) => m.default as Component<ChainProps>)
  ).then((c) => {
    chainComponent = c
    return c
  })
  return chainPromise
}

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

/** The Svelte server render adapter - pass to @nifrajs/web's `renderPage`. */
export const svelteAdapter: RenderAdapter = {
  // Svelte SSR is already synchronous + string-based, so this is the native shape: `renderToString`
  // returns the body directly (renderPage buffers it on the non-deferred fast path), and
  // `renderToStream` wraps the same string in a one-chunk stream for the deferred path. No streaming
  // renderer to skip here - but going straight to a string avoids the per-request stream allocation.
  // The seam allows `string | Promise<string>`, so the first render can resolve `Chain` while every
  // render after it stays a plain synchronous call - see `loadChain`.
  renderToString(chain, props) {
    const Chain = loadChain()
    const props$ = { chain, props, layoutData: props.layoutData }
    return Chain instanceof Promise
      ? Chain.then((C) => render(C, { props: props$ }).body)
      : render(Chain, { props: props$ }).body
  },
  renderToStream(chain, props) {
    // `Chain` folds the layout chain (page innermost gets `props`; layouts wrap via their `children`
    // snippet). Svelte's `render` returns { head, body }; the body goes into #root. (Svelte's dynamic
    // `head` - from <svelte:head> - isn't surfaced through the seam's static `hydrationHead`; nifra's
    // own meta/head API manages the document head instead.)
    const Chain = loadChain()
    const props$ = { chain, props, layoutData: props.layoutData }
    return Chain instanceof Promise
      ? Chain.then((C) => oneChunk(render(C, { props: props$ }).body))
      : oneChunk(render(Chain, { props: props$ }).body)
  },
  // Svelte's client `hydrate` reconciles against the existing DOM; no per-document bootstrap script is
  // needed (contrast Solid's generateHydrationScript) - the seam allows the empty string.
  hydrationHead() {
    return ""
  },
}
