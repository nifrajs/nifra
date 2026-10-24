/**
 * @nifrajs/web-svelte - the Svelte 5 render adapter for @nifrajs/web (server side). SSR via Svelte's
 * `render` (svelte/server), which returns HTML strings (Svelte SSR is string-based, not a stream),
 * wrapped in a one-chunk Web `ReadableStream` (the seam's shape). The layout-chain fold is the recursive
 * `Chain.svelte`. Client hydration lives in `@nifrajs/web-svelte/client`. Svelte components compile from
 * `.svelte` files, so this adapter ships a build plugin at `@nifrajs/web-svelte/plugin` (like
 * `@nifrajs/web-solid/plugin`) - there is no callable-component runtime.
 */
import type { RenderAdapter, RenderProps, RenderStreamOptions } from "@nifrajs/web"
import { ssrModuleLoader } from "@nifrajs/web"
import type { Component } from "svelte"
import { render as runtimeRender } from "svelte/server"
import { isSvelteUI } from "./ppr.ts"

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
/**
 * What `Chain.svelte` destructures from `$props()`.
 *
 * A type alias rather than an `interface` on purpose. `.svelte` files are compiled by a bundler, not
 * by tsc, so they arrive through the ambient shim as `Component<Record<string, unknown>>` and the load
 * below narrows that to this shape. An interface has no implicit index signature, so that narrowing is
 * a comparison between two unrelated types and `svelte-check` rejects it; a type alias does have one,
 * which makes the narrowing legal to state directly instead of laundering it through `unknown`.
 */
type ChainProps = {
  readonly chain: readonly unknown[]
  readonly props: RenderProps
  /** The page's data, apart from `props` so that the client can hand it over identity-checked. */
  readonly data: unknown
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
          // `import.meta.dirname`, not `node:url`: edge bundles resolve that to a browser polyfill with
          // no `fileURLToPath`, and this module is in every Svelte server bundle.
          load(`${import.meta.dirname}/Chain.svelte`),
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

/** What `KeepAlive.svelte` takes on the server: the one page the document renders, as a tree. */
type KeepAliveProps = {
  readonly initial: unknown
  readonly tree: readonly unknown[]
  readonly mount: unknown
}
let keepAliveComponent: Component<KeepAliveProps> | undefined
let keepAlivePromise: Promise<Component<KeepAliveProps>> | undefined
/** `KeepAlive.svelte`, the root of an app with a `keepAlive` route, loaded as `Chain` is. */
const loadKeepAlive = (): Component<KeepAliveProps> | Promise<Component<KeepAliveProps>> => {
  if (keepAliveComponent !== undefined) return keepAliveComponent
  const load = ssrModuleLoader()
  keepAlivePromise ??= (
    load !== undefined
      ? Promise.all([load(`${import.meta.dirname}/KeepAlive.svelte`), load("svelte/server")]).then(
          ([mod, server]) => {
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the dev server loaded `svelte/server`, whose `render` is the runtime's
            render = (server as { render: typeof runtimeRender }).render
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the dev server compiled KeepAlive.svelte, whose default export is the component
            return (mod as { default: Component<KeepAliveProps> }).default
          },
        )
      : import("./KeepAlive.svelte").then(
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: KeepAlive.svelte declares exactly these props
          (m) => m.default as Component<KeepAliveProps>,
        )
  ).then((c) => {
    keepAliveComponent = c
    return c
  })
  return keepAlivePromise
}

const noRef = (): (() => void) => () => {}

/**
 * The props of the keep-alive root for one server render: the chain as a single path of slot nodes,
 * the entries at `slots` inside the slot wrappers, which is what the browser's first render builds.
 */
function keptProps(
  chain: readonly unknown[],
  props: RenderProps,
  slots: readonly number[],
): KeepAliveProps {
  const state = { routeId: "", params: {}, path: "", data: props.data, pending: false }
  const page = chain.length - 1
  let node: Record<string, unknown> = {
    key: "\0page",
    depth: page,
    state,
    hidden: false,
    wrapped: slots.includes(page),
  }
  for (let depth = page - 1; depth >= 0; depth--) {
    node = {
      key: `\0layout${depth}`,
      depth,
      state,
      hidden: false,
      wrapped: slots.includes(depth),
      children: [node],
    }
  }
  const tree = [node]
  return {
    initial: state,
    tree,
    mount: {
      tree: () => tree,
      propsOf: () => props,
      chainOf: () => chain,
      entry: noRef,
      page: noRef,
      after: () => {},
    },
  }
}

function keptBodyOf(
  KeepAlive: Component<KeepAliveProps>,
  props: KeepAliveProps,
  options: RenderStreamOptions,
): string {
  const out = render(KeepAlive, { props })
  if (options.parts !== undefined) options.parts.head += out.head
  return out.body
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

/** The body of one render; what `<svelte:head>` rendered goes into the document's `<head>`. */
function bodyOf(
  Chain: Component<ChainProps>,
  props: ChainProps,
  options?: RenderStreamOptions,
): string {
  const out = render(Chain, { props })
  if (options?.parts !== undefined) options.parts.head += out.head
  return out.body
}

/** The Svelte server render adapter - pass to @nifrajs/web's `renderPage`. */
export const svelteAdapter: RenderAdapter = {
  documentParts: true,
  // Svelte SSR is already synchronous + string-based, so this is the native shape: `renderToString`
  // returns the body directly (renderPage buffers it on the non-deferred fast path), and
  // `renderToStream` wraps the same string in a one-chunk stream for the deferred path. No streaming
  // renderer to skip here - but going straight to a string avoids the per-request stream allocation.
  // The seam allows `string | Promise<string>`, so the first render can resolve `Chain` while every
  // render after it stays a plain synchronous call - see `loadChain`.
  renderToString(chain, props, options) {
    if (options?.slots !== undefined) {
      const KeepAlive = loadKeepAlive()
      const props$ = keptProps(chain, props, options.slots)
      return KeepAlive instanceof Promise
        ? KeepAlive.then((K) => keptBodyOf(K, props$, options))
        : keptBodyOf(KeepAlive, props$, options)
    }
    const Chain = loadChain()
    const props$ = { chain, props, data: props.data, layoutData: props.layoutData }
    return Chain instanceof Promise
      ? Chain.then((C) => bodyOf(C, props$, options))
      : bodyOf(Chain, props$, options)
  },
  renderToStream(chain, props, options) {
    // `Chain` folds the layout chain (page innermost gets `props`; layouts wrap via their `children`
    // snippet). Svelte's `render` returns { head, body }; the body goes into #root.
    if (options?.slots !== undefined) {
      const KeepAlive = loadKeepAlive()
      const props$ = keptProps(chain, props, options.slots)
      return KeepAlive instanceof Promise
        ? KeepAlive.then((K) => oneChunk(keptBodyOf(K, props$, options)))
        : oneChunk(keptBodyOf(KeepAlive, props$, options))
    }
    const Chain = loadChain()
    const props$ = { chain, props, data: props.data, layoutData: props.layoutData }
    return Chain instanceof Promise
      ? Chain.then((C) => oneChunk(bodyOf(C, props$, options)))
      : oneChunk(bodyOf(Chain, props$, options))
  },
  // A partially prerendered hole's HTML, from a `ui(Component, props)` value. Svelte puts its own `-`
  // before the id counter and refuses a prefix with `--`, so the seam's trailing `-` is dropped. The
  // client reads each id back from its comment marker, so the hole's root needs no prefix of its own.
  async renderFragment(produce, options) {
    const ui = produce()
    if (!isSvelteUI(ui)) {
      throw new TypeError(
        "[nifra/web-svelte] a hole's render and fallback must return ui(Component, props)",
      )
    }
    // `render` is the dev server's copy once Chain comes from there; see loadChain.
    await loadChain()
    const idPrefix = options.idPrefix?.replace(/-$/, "")
    return render(
      ui.component,
      idPrefix === undefined ? { props: ui.props } : { props: ui.props, idPrefix },
    ).body
  },
  // Svelte's client `hydrate` reconciles against the existing DOM; no per-document bootstrap script is
  // needed (contrast Solid's generateHydrationScript) - the seam allows the empty string.
  hydrationHead() {
    return ""
  },
}
