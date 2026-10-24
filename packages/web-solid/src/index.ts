/**
 * @nifrajs/web-solid - the Solid render adapter for @nifrajs/web (server side). Streaming SSR via
 * `renderToStream` + `generateHydrationScript`; the layout-chain fold is in `./compose`. Client
 * hydration lives in `@nifrajs/web-solid/client` (Solid's browser build), and the Solid Babel
 * Bun-plugin in `@nifrajs/web-solid/plugin`.
 */
import type { RenderAdapter, RenderProps, RenderStreamOptions, RouterState } from "@nifrajs/web"
import { type JSX, sharedConfig } from "solid-js"
import {
  generateHydrationScript,
  renderToStream as solidRenderToStream,
  renderToString as solidRenderToString,
} from "solid-js/web"
import { compose } from "./compose.ts"
import { documentTree, KeepAliveView } from "./keep-alive-view.ts"

const HYDRATION_HEAD = generateHydrationScript()

// An unset NODE_ENV counts as production, as for the framework's own error pages.
const showsErrors = (): boolean => {
  const nodeEnv = typeof process === "undefined" ? undefined : process.env?.NODE_ENV
  return nodeEnv === "development" || nodeEnv === "test"
}

/** What the browser receives for an error Solid hands to hydration: its text names server internals. */
function redactedError(): Error {
  // Built bare: a constructed Error carries a stack and, on Bun, the line, column and file it was made
  // at, and Solid serializes every own property.
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Object.create over Error.prototype with a message is an Error minus its stack.
  return Object.create(Error.prototype, {
    message: { value: "Internal Server Error", writable: true, configurable: true },
  }) as Error
}

/**
 * Render `app` with every Error that Solid serializes for hydration replaced. An `<ErrorBoundary>` that
 * caught on the server, or a failed resource, otherwise ships the message and stack in an inline script.
 * Nested contexts copy this one, so they keep the wrapped `serialize`. NODE_ENV is read only when an
 * Error is serialized: on Node every `process.env` read is a native call, and this runs every render.
 */
function redactingErrors<T>(app: () => T): () => T {
  return () => {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Solid's server renderers set a context with serialize; the check below handles its absence.
    const context = sharedConfig.context as
      | { serialize?: (id: string, value: unknown) => void }
      | undefined
    const serialize = context?.serialize
    if (context !== undefined && serialize !== undefined) {
      context.serialize = (id, value) =>
        serialize(id, value instanceof Error && !showsErrors() ? redactedError() : value)
    }
    return app()
  }
}

const noRef = (): undefined => undefined

/** The chain as the browser's keep-alive view renders it, in an app with a `keepAlive` route. */
function documentView(chain: readonly unknown[], props: RenderProps, slots: readonly number[]) {
  const state: RouterState = { routeId: "", params: {}, path: "", data: props.data, pending: false }
  const tree = documentTree(chain, state, slots)
  return (): JSX.Element =>
    KeepAliveView({
      tree: () => tree,
      state: () => state,
      mount: { propsOf: () => props, chainOf: () => chain, entry: noRef, page: noRef },
    })
}

const appOf = (chain: readonly unknown[], props: RenderProps, options?: RenderStreamOptions) =>
  redactingErrors(
    options?.slots === undefined
      ? compose(chain, props)
      : documentView(chain, props, options.slots),
  )

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
      ? solidRenderToString(app)
      : solidRenderToString(app, { nonce: options.nonce })
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
        ? solidRenderToString(() => {
            // On the root context, so nodes resolved after `view` returns are unkeyed too.
            if (sharedConfig.context !== undefined)
              Reflect.set(sharedConfig.context, "noHydrate", true)
            return view()
          })
        : solidRenderToString(view, { renderId: options.idPrefix })
    } finally {
      // Unset included: `context` is an optional property.
      Reflect.set(sharedConfig, "context", page)
    }
  },
  renderToStream(chain, props, options) {
    // Solid's `renderToStream` streams `Uint8Array` chunks into a Web `WritableStream` via
    // `pipeTo` (fire-and-forget - returns void); pipe into a TransformStream and hand back the
    // readable side. Suspense boundaries stream as they resolve; `generateHydrationScript()` (in
    // <head>) seeds client hydration. A render failure errors `ts.readable`, which `renderPage`
    // surfaces on the response body. The nonce reaches the resource and boundary scripts Solid streams.
    const ts = new TransformStream<Uint8Array, Uint8Array>()
    const app = appOf(chain, props, options)
    const stream =
      options?.nonce === undefined
        ? solidRenderToStream(app)
        : solidRenderToStream(app, { nonce: options.nonce })
    stream.pipeTo(ts.writable)
    return ts.readable
  },
  hydrationHead() {
    return HYDRATION_HEAD
  },
}
