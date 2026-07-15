import { definePlugin } from "@nifrajs/core/server"

export interface RequestIdOptions {
  /** Header read for an inbound id (trace propagation) + echoed on the response. Default `"x-request-id"`. */
  readonly header?: string
  /** Generate an id when the inbound header is absent. Default `crypto.randomUUID()`. */
  readonly generate?: () => string
}

/**
 * A {@link definePlugin} plugin that gives every request a stable id: it reuses an inbound
 * `x-request-id` (or generates one), exposes it on the handler context as **`c.requestId`** (typed,
 * threaded by `derive`), and echoes it on the response header. Idempotent — applying it twice is a
 * no-op.
 *
 * ```ts
 * app.use(requestId())          // c.requestId available downstream; X-Request-Id on responses
 * ```
 */
export function requestId(options: RequestIdOptions = {}) {
  const header = options.header ?? "x-request-id"
  const generate = options.generate ?? (() => crypto.randomUUID())
  return definePlugin("requestId", (app) =>
    app.derive((c) => {
      const id = c.req.headers.get(header) ?? generate()
      c.set.headers[header] = id // echo on the response (route handlers)
      return { requestId: id }
    }),
  )
}
