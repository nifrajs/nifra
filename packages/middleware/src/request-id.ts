import { type ContextPlugin, defineContextPlugin } from "@nifrajs/core/server"
import { withHeaders, withNodeHeaders } from "./_utils.ts"

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
 * `c.set.headers` onto a handler-returned `Response`, so the echo lives in app-global
 * `onRequest`/`onResponse` hooks (paired through a `WeakMap` keyed on the request, logger()'s
 * shape) with node twins, keeping the Node adapter on its direct writer. Idempotent - applying it
 * twice is a no-op.
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
  // Web-lane request-to-response pairing. Entries are deleted in onResponse, so the map holds no
  // per-request state past the response. The Node-direct lane never touches it: there the derive's
  // `c.set` write carries the id into the outcome record, and the response twin defers to it.
  const ids = new WeakMap<Request, string>()
  // defineContextPlugin, not definePlugin: the latter would infer `app` as `AnyServer` here and make
  // `.use(requestId())` return `Server<any, any>`, erasing the route registry for every route the app
  // declares afterwards - and with it the end-to-end types of any typed client built from the app.
  return defineContextPlugin<{ requestId: string }>("requestId", (app) =>
    app
      // No `name` on the bundle: the surrounding plugin's "requestId" dedupe already makes the
      // install idempotent, and a bundle named the same would be skipped as already-installed.
      .use({
        onRequest(req) {
          // Only a GENERATED id needs carrying - an inbound one is re-readable from the request in
          // onResponse and the derive, so the propagation path never touches the map.
          if (req.headers.get(header) === null) ids.set(req, generate())
          return undefined
        },
        // Deliberately a no-op: its presence keeps the Node adapter's native request lane engaged
        // (an unpaired onRequest would disengage it and force a Web Request per request). The node
        // lane needs no request-time id - the derive computes it, and the response twin generates
        // one only for responses no derive saw.
        onNodeRequest() {
          return undefined
        },
        onResponse(res, req) {
          const id = ids.get(req)
          ids.delete(req)
          // Already carried (the derive's `c.set` write merged into a framework-rendered response,
          // or the handler set it explicitly): leave the response untouched.
          if (res.headers.get(header) !== null) return res
          // The stored id; else the inbound header, then a fresh id - so a response produced before
          // this plugin's onRequest ran (an earlier middleware's short-circuit) is still covered.
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
          withNodeHeaders(res, (headers) => {
            headers[wireHeader] = req.header(header) ?? generate()
          })
        },
      })
      .derive((c) => {
        // Inbound header first (readable on every lane without materializing a Request), then the
        // id onRequest stored - same value in the same precedence, so the Web lane never generates
        // a second id. On the Node-direct lane the Web onRequest never ran (the map lookup is a
        // miss against the source's cached lazy request shell) and the id is generated HERE, once;
        // the `c.set` write below carries it into the outcome record, where the response twin sees
        // it as already echoed - keeping header and `c.requestId` the same value on every lane.
        const id = c.header(header) ?? ids.get(c.req) ?? generate()
        c.set.headers[wireHeader] = id
        return { requestId: id }
      }),
  )
}
