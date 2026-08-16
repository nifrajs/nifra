/**
 * MEASUREMENT PROTOTYPE - a thin compact-edge server SHELL, to answer the one question Phase-0 left
 * open: what does keeping the real `server().get().post()` DX cost on top of the 4.8 KB kernel?
 *
 * worker-nifra-kernel hand-wired dispatch against the raw router, so it does NOT charge for the
 * builder API. This shell DOES: a chainable `.get/.post`, per-route schema attach, a `c` context, and
 * `toFetchHandler`, mirroring `@nifrajs/core/server`'s surface exactly as worker-nifra.ts uses it.
 *
 * It is NOT a reimplementation of the moat - the body trust boundary IS the shipped lane. The whole
 * content-type dispatch (bounded read + Content-Length pre-reject, prototype-pollution guard,
 * urlencoded-form vs JSON vs 415) runs through the one `readBodyFramed` free function the full
 * `Server`'s fused body runner calls, so there is no re-derived assembly order left to drift:
 *   - body trust boundary (read + cap + proto-guard + framing)  request-context.ts  readBodyFramed
 *   - its rejection envelope (413 / 415 / malformed)            respond.ts          toResponse(plainError)
 *   - query parse                                               query.ts            queryObjectOf/searchOf
 *   - Standard Schema validation at the boundary                inline, the route's own schema
 *   - the shell's own 404 / 422 / 500 envelope                  inline
 *
 * Honest scope of the SHELL (differences from the shipped Server, none of them moat-weakening):
 *   - always the delivered-byte cap (the safe unmarked path); no trustBodyFraming fused fast lane
 *   - the shell's own 404/422/500 use a minimal envelope; body-lane rejections use core's exact one
 *   - no lifecycle / around / cookies / response-contract / deadline surface (the point: it is compact)
 * These keep the number a LOWER BOUND on a real edge entrypoint's size, never an under-count of the
 * moat. It exists only to price the DX before the Phase-1 extraction is committed.
 */

import { Router } from "@nifrajs/core/router"
import { queryObjectOf, searchOf } from "../../packages/core/src/server/query.ts"
import { readBodyFramed } from "../../packages/core/src/server/request-context.ts"
import { toResponse } from "../../packages/core/src/server/respond.ts"
import { EMPTY_RESPONSE_CONTROLS } from "../../packages/core/src/server/runtime-core.ts"

/** Standard Schema v1 - the exact validate contract the shipped server calls; matches worker-nifra.ts. */
interface StandardResult<Out> {
  readonly value?: Out
  readonly issues?: readonly { readonly message: string }[]
}
interface StandardSchemaV1<Out> {
  readonly ["~standard"]: {
    readonly version: 1
    readonly vendor: string
    validate(value: unknown): StandardResult<Out> | Promise<StandardResult<Out>>
  }
}

interface EdgeContext {
  readonly request: Request
  readonly params: Record<string, string>
  query(): Record<string, string | string[]>
  readonly body: unknown
}

type Handler = (c: EdgeContext) => unknown | Promise<unknown>
interface RouteEntry {
  readonly bodySchema?: StandardSchemaV1<unknown>
  readonly handler: Handler
}

/** Default request-body cap - the shipped Server's DEFAULT_MAX_BODY_BYTES equivalent for the edge. */
const MAX_BODY_BYTES = 1024 * 1024
const PROTO_POLICY = "reject" as const

/** Every rejection leaves through one structured envelope, never a bare string. */
const errorResponse = (status: number, message: string): Response =>
  Response.json({ error: { status, message } }, { status })

class EdgeServer {
  readonly #router = new Router<RouteEntry>()

  get(path: string, handler: Handler): this {
    this.#router.add("GET", path, { handler })
    return this
  }

  // Overloads mirror the shipped DX: `.post(path, handler)` or `.post(path, { body }, handler)`, with
  // `c.body` narrowed to the schema's output type. Types only - zero runtime, zero bundle contribution.
  post<B>(
    path: string,
    schema: { body: StandardSchemaV1<B> },
    handler: (c: EdgeContext & { body: B }) => unknown | Promise<unknown>,
  ): this
  post(path: string, handler: Handler): this
  post(path: string, a: { body: StandardSchemaV1<unknown> } | Handler, b?: Handler): this {
    // Build the entry WITHOUT a `bodySchema` key when there is none, rather than setting it to
    // `undefined` - the schema-present branch is the only one that carries the body lane.
    if (typeof a === "function") this.#router.add("POST", path, { handler: a })
    else this.#router.add("POST", path, { bodySchema: a.body, handler: b as Handler })
    return this
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const match = this.#router.find(request.method, url.pathname)
    if (!match.found) return errorResponse(404, "not found")
    const { bodySchema, handler } = match.payload

    // Build the context, run the handler, render the result - shared by both the body and no-body
    // paths so validation is the only thing the body lane adds on top of the shipped trust boundary.
    const dispatch = async (body: unknown): Promise<Response> => {
      const c: EdgeContext = {
        request,
        params: match.params,
        query: () => queryObjectOf(searchOf(request.url)),
        body,
      }
      let out: unknown
      try {
        out = await handler(c)
      } catch (err) {
        if (err instanceof Response) return err
        return errorResponse(500, "internal error")
      }
      return out instanceof Response ? out : Response.json(out)
    }

    if (bodySchema === undefined) return dispatch(undefined)

    // The body trust boundary IS the shipped lane: readBodyFramed does the content-type dispatch,
    // bounded read + Content-Length pre-reject, and prototype-poisoning guard the full Server's fused
    // body runner uses. The shell only layers the route's own schema validation on the parsed value.
    return readBodyFramed<Response>(
      request,
      MAX_BODY_BYTES,
      PROTO_POLICY,
      async (parsed) => {
        // Parse, don't cast - the boundary handed us guarded JSON; the schema is the last gate.
        const result = await bodySchema["~standard"].validate(parsed)
        if (result.issues !== undefined || result.value === undefined) {
          return errorResponse(422, "validation failed")
        }
        return dispatch(result.value)
      },
      // A framing rejection (413 too-large / 415 unsupported-media-type) arrives as a ResponseResult;
      // render it through the same seam the Server does so the envelope is byte-for-byte the shipped one.
      (r) => (r instanceof Response ? r : toResponse(r, EMPTY_RESPONSE_CONTROLS)),
      () => errorResponse(400, "invalid json"),
    )
  }
}

export type { StandardSchemaV1 }
export function server(): EdgeServer {
  return new EdgeServer()
}
export const toFetchHandler = (
  app: EdgeServer,
): { fetch(request: Request): Promise<Response> } => ({
  fetch: (request) => app.fetch(request),
})
