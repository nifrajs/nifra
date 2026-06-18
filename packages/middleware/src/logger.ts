import { definePlugin } from "@nifrajs/core"

/** Structured fields logged per request. */
export interface RequestLogFields {
  readonly method: string
  readonly path: string
  readonly status: number
  /** Wall-clock duration in ms (0 if the start couldn't be paired). */
  readonly ms: number
}

export interface LoggerOptions {
  /** Sink for each line. Default: `console.log(JSON.stringify(fields))`. Route to your own logger here. */
  readonly log?: (fields: RequestLogFields) => void
}

/**
 * A {@link definePlugin} plugin that logs one structured line per request — method, path, status,
 * and duration — via `onRequest`/`onResponse` (so it covers 404s and errors too). The start time is
 * paired to the request through a `WeakMap` (no per-request allocation leak). Idempotent.
 */
export function logger(options: LoggerOptions = {}) {
  // A request logger's whole job is to log; the default writes JSON to stdout, routable via `log`.
  const sink = options.log ?? ((fields: RequestLogFields) => console.log(JSON.stringify(fields)))
  const starts = new WeakMap<Request, number>()
  return definePlugin("logger", (app) =>
    app
      .onRequest((req) => {
        starts.set(req, performance.now())
        return undefined
      })
      .onResponse((res, req) => {
        const start = starts.get(req)
        starts.delete(req)
        sink({
          method: req.method,
          path: new URL(req.url).pathname,
          status: res.status,
          ms: start === undefined ? 0 : Math.round(performance.now() - start),
        })
        return res
      }),
  )
}
