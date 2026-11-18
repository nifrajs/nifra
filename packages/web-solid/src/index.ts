/**
 * @nifrajs/web-solid - the Solid render adapter for @nifrajs/web (server side). Streaming SSR via
 * `renderToStream` + `generateHydrationScript`; the layout-chain fold is in `./compose`. Client
 * hydration lives in `@nifrajs/web-solid/client` (Solid's browser build), and the Solid compiler
 * Bun-plugin in `@nifrajs/web-solid/plugin`.
 */
import type { RenderAdapter, RenderProps, RenderStreamOptions, RouterState } from "@nifrajs/web"
import {
  generateHydrationScript,
  type JSX,
  renderToStream as solidRenderToStream,
  renderToString as solidRenderToString,
} from "@solidjs/web"
import { createComponent, NoHydration } from "solid-js"
import { sharedConfig } from "solid-js/internal"
import { compose } from "./compose.ts"
import { documentTree, KeepAliveView } from "./keep-alive-view.ts"

const HYDRATION_HEAD = generateHydrationScript()

// An unset NODE_ENV counts as production, as for the framework's own error pages.
const showsErrors = (): boolean => {
  // No `?.`: a bundler's NODE_ENV define replaces only the plain member read.
  const nodeEnv = typeof process === "undefined" ? undefined : process.env.NODE_ENV
  return nodeEnv === "development" || nodeEnv === "test"
}

/** What the browser receives for an error Solid serializes for hydration: its text names server internals. */
function redactedError(): Error {
  // Built bare: a constructed Error carries a stack and, on Bun, the line, column and file it was made
  // at, and Solid serializes every own property. Solid's own generic error is constructed, so it would
  // ship the absolute path of its server build.
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Object.create over Error.prototype with a message is an Error minus its stack.
  return Object.create(Error.prototype, {
    message: { value: "Internal Server Error", writable: true, configurable: true },
  }) as Error
}

/**
 * What the browser receives for an error Solid serializes for hydration (an `<Errored>` that caught on
 * the server, a rejected `<Loading>` source). Solid's own policy keys on a package condition rather than
 * NODE_ENV and builds its generic error with a stack; this hook makes the framework's NODE_ENV rule decide
 * and ships the bare error. NODE_ENV is read only when an error is serialized: on Node every
 * `process.env` read is a native call, and this runs every render.
 */
const errorForClient = (error: unknown): unknown => (showsErrors() ? error : redactedError())

const noRef = (): undefined => undefined

/** The chain as the browser's keep-alive view renders it, in an app with a `keepAlive` route. */
function documentView(chain: readonly unknown[], props: RenderProps, slots: readonly number[]) {
  const state: RouterState = { routeId: "", params: {}, path: "", data: props.data, pending: false }
  const tree = documentTree(chain, state, slots)
  return (): JSX.Element =>
    KeepAliveView({
      tree: () => tree,
      shown: props,
      mount: { propsOf: () => props, chainOf: () => chain, entry: noRef, page: noRef },
    })
}

const appOf = (chain: readonly unknown[], props: RenderProps, options?: RenderStreamOptions) =>
  options?.slots === undefined ? compose(chain, props) : documentView(chain, props, options.slots)

/** The Solid server render adapter - pass to @nifrajs/web's `renderPage`. */
export const solidAdapter: RenderAdapter = {
  // Synchronous one-pass render for non-deferred pages (renderPage's buffered fast path). Solid's
  // `renderToString` emits the same hydratable markup (same `data-hk` keys seeded by
  // `generateHydrationScript()`) as `renderToStream`, but skips the TransformStream + Solid's
  // streaming machinery - the heaviest of the five renderers on Bun. A page that defer()s/Suspends
  // takes `renderToStream` below (progressive resolution needs it).
  renderToString(chain, props, options) {
    const app = appOf(chain, props, options)
    return options?.nonce === undefined
      ? solidRenderToString(app, { onError: errorForClient })
      : solidRenderToString(app, { nonce: options.nonce, onError: errorForClient })
  },
  // A partially prerendered hole's HTML: its own root under `renderId`, so its hydration keys and
  // `createUniqueId`s never collide with the page's, and its JSX runs inside the render that keys it.
  // Without a prefix (a fallback, never hydrated) it carries no hydration keys at all.
  renderFragment(ui, options) {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a hole's render returns Solid output; the seam erases it to unknown.
    const view = () => ui() as JSX.Element
    // `renderToString` leaves its context in Solid's shared config; a page mid-render keeps its own.
    const page = sharedConfig.context
    try {
      return options.idPrefix === undefined
        ? solidRenderToString(() =>
            createComponent(NoHydration, {
              get children() {
                // Resolved here, not by the renderer afterwards: the unkeyed scope ends with this call.
                let node: unknown = view()
                while (typeof node === "function") node = node()
                // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a function-free node is the Solid output the hole's render produced.
                return node as JSX.Element
              },
            }),
          )
        : solidRenderToString(view, { renderId: options.idPrefix })
    } finally {
      // Unset included: `context` is an optional property.
      Reflect.set(sharedConfig, "context", page)
    }
  },
  renderToStream(chain, props, options) {
    // Solid's `renderToStream` hands back the `Uint8Array` chunks as a Web `ReadableStream`. Loading
    // boundaries stream as they resolve; `generateHydrationScript()` (in <head>) seeds client hydration. A
    // render failure errors the stream, which `renderPage` surfaces on the response body. The nonce
    // reaches the boundary scripts Solid streams.
    const app = appOf(chain, props, options)
    return (
      options?.nonce === undefined
        ? solidRenderToStream(app, { onError: errorForClient })
        : solidRenderToStream(app, { nonce: options.nonce, onError: errorForClient })
    ).readable
  },
  hydrationHead() {
    return HYDRATION_HEAD
  },
}
