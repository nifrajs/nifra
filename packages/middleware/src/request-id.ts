import { type ContextPlugin, defineContextPlugin } from "@nifrajs/core/server"
import { setNodeHeader, withHeaders } from "./_utils.ts"

export interface RequestIdOptions {
  /** Header read for an inbound id (trace propagation) + echoed on the response. Default `"x-request-id"`. */
  readonly header?: string
  /** Generate an id when the inbound header is absent. Default `crypto.randomUUID()`. */
  readonly generate?: () => string
}

/**
 * A {@link defineContextPlugin} plugin that gives every request a stable id: it reuses an inbound
 * `x-request-id` (or generates one), exposes it on the handler context as **`c.requestId`** (typed,
 * threaded by `derive`), and echoes it on EVERY response leaving the app - handler-returned raw
 * `Response`s and redirects, `onRequest` short-circuits (an auth 401, an admission 429), and
 * framework-generated 404/405/422/timeout responses included. Core deliberately does not merge
 * `c.set.headers` onto a handler-returned `Response`, so the echo lives in an app-global
 * `onResponse` hook (paired with the derive through a `WeakMap` keyed on the request) with a node
 * twin, keeping the Node adapter on its direct writer with no request-walk cost. Idempotent -
 * applying it twice is a no-op.
 *
 * ```ts
 * app.use(requestId())          // c.requestId available downstream; X-Request-Id on responses
 * ```
 */
export function requestId(options: RequestIdOptions = {}): ContextPlugin<{ requestId: string }> {
  const header = options.header ?? "x-request-id"
  // The wire spelling: `c.set.headers` and the Node outcome record both store lowercase names, so
  // the response twin's "already echoed?" probe and the derive's write must agree on it.
  const wireHeader = header.toLowerCase()
  const generate = options.generate ?? (() => crypto.randomUUID())
  // Web-lane derive-to-response pairing for GENERATED ids (an inbound one is re-readable from the
  // request in onResponse). Entries are deleted in onResponse; a Node-lane derive also writes here
  // but its id travels via the `c.set` write into the outcome record, and the weakly-held entry is
  // simply collected with the request.
  const ids = new WeakMap<Request, string>()
  // defineContextPlugin, not definePlugin: the latter would infer `app` as `AnyServer` here and make
  // `.use(requestId())` return `Server<any, any>`, erasing the route registry for every route the app
  // declares afterwards - and with it the end-to-end types of any typed client built from the app.
  return defineContextPlugin<{ requestId: string }>("requestId", (app) =>
    app
      // No `name` on the bundle: the surrounding plugin's "requestId" dedupe already makes the
      // install idempotent, and a bundle named the same would be skipped as already-installed.
      // Response hooks ONLY - no onRequest, so the bundle adds nothing to the request walk and the
      // Node adapter's native request lane stays engaged without needing a no-op twin.
      .use({
        onResponse(res, req) {
          const id = ids.get(req)
          ids.delete(req)
          // Already carried (the derive's `c.set` write merged into a framework-rendered response,
          // or the handler set it explicitly): leave the response untouched.
          if (res.headers.get(header) !== null) return res
          // The id the derive generated; else the inbound header, then a fresh id - so a response
          // no derive saw (a 404, an earlier middleware's short-circuit) is still covered.
          const echo = id ?? req.headers.get(header) ?? generate()
          return withHeaders(res, (headers) => {
            headers.set(header, echo)
          })
        },
        onNodeResponse(res, req) {
          // The common node path (a handler route, whose derive wrote the id through `c.set`) pays
          // exactly this one record-property check. Anything the derive never saw - a 404, a native
          // short-circuit - gets the inbound id or a fresh one here.
          if (res.headers?.[wireHeader] !== undefined) return
          setNodeHeader(res, wireHeader, req.header(header) ?? generate())
        },
      })
      .derive((c) => {
        // Inbound header first (readable on every lane without materializing a Request); generate
        // otherwise, ONCE. A generated id is stored keyed on `c.req` so the Web onResponse hook
        // echoes the exact id a raw-Response handler saw as `c.requestId`; the `c.set` write below
        // carries it into a framework-rendered result on every lane - on Node-direct, into the
        // outcome record, where the response twin sees it as already echoed. Header and
        // `c.requestId` are therefore the same value everywhere with a single generation.
        const inbound = c.header(header)
        const id = inbound ?? generate()
        if (inbound === null) ids.set(c.req, id)
        c.set.headers[wireHeader] = id
        return { requestId: id }
      }),
  )
}
