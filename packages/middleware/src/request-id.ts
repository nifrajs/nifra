import { type ContextPlugin, defineContextPlugin } from "@nifrajs/core/server"

export interface RequestIdOptions {
  /** Header read for an inbound id (trace propagation) + echoed on the response. Default `"x-request-id"`. */
  readonly header?: string
  /** Generate an id when the inbound header is absent. Default `crypto.randomUUID()`. */
  readonly generate?: () => string
}

/**
 * A {@link defineContextPlugin} plugin that gives every request a stable id: it reuses an inbound
 * `x-request-id` (or generates one), exposes it on the handler context as **`c.requestId`** (typed,
 * threaded by `derive`), and echoes it on the response header. Idempotent - applying it twice is a
 * no-op.
 *
 * ```ts
 * app.use(requestId())          // c.requestId available downstream; X-Request-Id on responses
 * ```
 */
export function requestId(options: RequestIdOptions = {}): ContextPlugin<{ requestId: string }> {
  const header = options.header ?? "x-request-id"
  const generate = options.generate ?? (() => crypto.randomUUID())
  // defineContextPlugin, not definePlugin: the latter would infer `app` as `AnyServer` here and make
  // `.use(requestId())` return `Server<any, any>`, erasing the route registry for every route the app
  // declares afterwards - and with it the end-to-end types of any typed client built from the app.
  return defineContextPlugin<{ requestId: string }>("requestId", (app) =>
    app.derive((c) => {
      const id = c.header(header) ?? generate()
      c.set.headers[header] = id // echo on the response (route handlers)
      return { requestId: id }
    }),
  )
}
