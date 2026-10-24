import {
  defineIdentityPlugin,
  type IdentityPlugin,
  pathnameOf,
  routeTemplateOf,
} from "@nifrajs/core/server"

/** Structured fields logged per request. */
export interface RequestLogFields {
  readonly method: string
  /**
   * The matched route template (`/share/:token`), so ids and tokens a path carries stay out of the
   * logs; the raw pathname when no route matched, or with `rawPath`.
   */
  readonly path: string
  readonly status: number
  /** Wall-clock duration in ms (0 if the start couldn't be paired). */
  readonly ms: number
}

export interface LoggerOptions {
  /** Sink for each line. Default: `console.log(JSON.stringify(fields))`. Route to your own logger here. */
  readonly log?: (fields: RequestLogFields) => void
  /** Log the raw pathname even when a route matched. Default `false`. */
  readonly rawPath?: boolean
}

/**
 * A {@link defineIdentityPlugin} plugin that logs one structured line per request - method, route,
 * status, and duration - via `onRequest`/`onResponse` (so it covers 404s and errors too). The query
 * string is never logged. The start time is paired to the request through a `WeakMap` (no
 * per-request allocation leak). Idempotent.
 *
 * It adds no context and registers no routes, so it is type-identity: routes declared after
 * `.use(logger())` keep their types. (Under `definePlugin` they would not - see that helper's
 * FOOTGUN note.)
 */
export function logger(options: LoggerOptions = {}): IdentityPlugin {
  // A request logger's whole job is to log; the default writes JSON to stdout, routable via `log`.
  const sink = options.log ?? ((fields: RequestLogFields) => console.log(JSON.stringify(fields)))
  const starts = new WeakMap<Request, number>()
  // Twin-side starts, keyed by the NodeRequestContext identity (the same object reaches the request
  // and response twins), so Node logging never has to materialize a Web `Request`.
  const nativeStarts = new WeakMap<object, number>()
  const rawPath = options.rawPath === true
  return defineIdentityPlugin("logger", (app) => {
    const routeOf = routeTemplateOf(app)
    const pathOf = (method: string, path: string): string =>
      rawPath ? path : (routeOf(method, path) ?? path)
    return app.use({
      onRequest(req) {
        starts.set(req, performance.now())
        return undefined
      },
      onNodeRequest(req) {
        nativeStarts.set(req, performance.now())
        return undefined
      },
      onResponse(res, req) {
        const start = starts.get(req)
        starts.delete(req)
        sink({
          method: req.method,
          path: pathOf(req.method, new URL(req.url).pathname),
          status: res.status,
          ms: start === undefined ? 0 : Math.round(performance.now() - start),
        })
        return res
      },
      onNodeResponse(res, req) {
        const start = nativeStarts.get(req)
        nativeStarts.delete(req)
        sink({
          method: req.method,
          path: pathOf(req.method, pathnameOf(req.url)),
          status: res.status,
          ms: start === undefined ? 0 : Math.round(performance.now() - start),
        })
      },
    })
  })
}
