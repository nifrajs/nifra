/**
 * `@nifrajs/edge` - a compact fetch-handler server for edge and serverless runtimes (Cloudflare
 * Workers, Vercel Edge, Deno Deploy, Bun). It keeps the `server().get().post()` DX and the full
 * request trust boundary, in a fraction of the bundle: the whole content-type dispatch (bounded read,
 * Content-Length pre-reject, prototype-pollution guard, JSON / urlencoded framing, 413 / 415) runs
 * through the ONE lane `@nifrajs/core`'s full Server calls - imported, never re-derived - so there is
 * no second copy of the security contract to drift.
 *
 * What it is NOT (the compactness is the point): no lifecycle / around hooks, cookies, response
 * contracts, deadlines, WebSockets, or plugins. Reach for `@nifrajs/core`'s `server()` when an app
 * needs those. The rejection envelopes here are byte-for-byte the full Server's, so an app can grow
 * from one to the other without its clients noticing.
 */

import {
  EMPTY_RESPONSE_CONTROLS,
  type ProtoPoisoning,
  plainError,
  plainValidationError,
  type QueryValue,
  queryObjectOf,
  type ResponseResult,
  readBodyFramed,
  searchOf,
  toResponse,
} from "@nifrajs/core/edge-kit"
import {
  type Method,
  type Params,
  Router,
  type StandardIssue,
  type StandardSchemaV1,
  toFetchHandler,
} from "@nifrajs/core/server"

/** The full Server's `DEFAULT_MAX_BODY_BYTES` - the same 1 MB cap, so the two agree on `413`. */
const DEFAULT_MAX_BODY_BYTES = 1_000_000

/** The request handed to a route. Compact by design: no cookies, no response builder - return a
 * value (rendered as JSON) or a `Response` for full control. */
export interface EdgeContext<Path extends string = string, Body = unknown> {
  /** The raw `Request`. */
  readonly request: Request
  /** Path parameters, typed from the route pattern (`/users/:id` -> `{ id: string }`). */
  readonly params: Params<Path>
  /** The parsed, schema-validated body, or `undefined` on a route with no body schema. */
  readonly body: Body
  /** The query string parsed to an object, computed on demand. */
  query(): Record<string, QueryValue>
  /** Read a request header (case-insensitive), or `null`. */
  header(name: string): string | null
}

/** A route handler: returns a value (rendered as JSON), a `Response`, or a promise of either. A
 * thrown `Response` is sent as-is; any other throw becomes a `500`. */
export type EdgeHandler<Path extends string = string, Body = unknown> = (
  c: EdgeContext<Path, Body>,
) => unknown | Promise<unknown>

interface RouteEntry {
  readonly bodySchema?: StandardSchemaV1<unknown>
  readonly handler: EdgeHandler
}

/** Construction-time options. Both mirror `@nifrajs/core`'s `ServerOptions` defaults. */
export interface EdgeOptions {
  /** Maximum request body size in bytes before a `413`. Defaults to 1 MB. */
  readonly maxBodyBytes?: number
  /** Prototype-poisoning policy for JSON bodies. Defaults to `"reject"`. */
  readonly protoPoisoning?: ProtoPoisoning
}

/** Render a rejection - a `Response` passes through, a plain `ResponseResult` (413 / 415 / 422 / 404
 * / 405 / 500) goes through the SAME renderer the full Server uses, so the wire bytes match. */
const render = (r: Response | ResponseResult): Response =>
  r instanceof Response ? r : toResponse(r, EMPTY_RESPONSE_CONTROLS)

/** A body-schema wrapper: `{ body }` narrows `c.body` to the schema's output type. */
interface BodySchema<Body> {
  readonly body: StandardSchemaV1<Body>
}

export class EdgeServer {
  readonly #router = new Router<RouteEntry>()
  readonly #maxBodyBytes: number
  readonly #protoPoisoning: ProtoPoisoning

  constructor(options: EdgeOptions = {}) {
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    this.#protoPoisoning = options.protoPoisoning ?? "reject"
  }

  #route(method: Method, path: string, entry: RouteEntry): this {
    this.#router.add(method, path, entry)
    return this
  }

  // Body-less verbs: handler only.
  get<const Path extends string>(path: Path, handler: EdgeHandler<Path>): this {
    return this.#route("GET", path, { handler: handler as EdgeHandler })
  }
  head<const Path extends string>(path: Path, handler: EdgeHandler<Path>): this {
    return this.#route("HEAD", path, { handler: handler as EdgeHandler })
  }
  options<const Path extends string>(path: Path, handler: EdgeHandler<Path>): this {
    return this.#route("OPTIONS", path, { handler: handler as EdgeHandler })
  }

  // Body-bearing verbs: `(path, handler)` or `(path, { body }, handler)`, with `c.body` narrowed.
  post<const Path extends string, Body>(
    path: Path,
    schema: BodySchema<Body>,
    handler: EdgeHandler<Path, Body>,
  ): this
  post<const Path extends string>(path: Path, handler: EdgeHandler<Path>): this
  post(path: string, a: BodySchema<unknown> | EdgeHandler, b?: EdgeHandler): this {
    return this.#bodyRoute("POST", path, a, b)
  }

  put<const Path extends string, Body>(
    path: Path,
    schema: BodySchema<Body>,
    handler: EdgeHandler<Path, Body>,
  ): this
  put<const Path extends string>(path: Path, handler: EdgeHandler<Path>): this
  put(path: string, a: BodySchema<unknown> | EdgeHandler, b?: EdgeHandler): this {
    return this.#bodyRoute("PUT", path, a, b)
  }

  patch<const Path extends string, Body>(
    path: Path,
    schema: BodySchema<Body>,
    handler: EdgeHandler<Path, Body>,
  ): this
  patch<const Path extends string>(path: Path, handler: EdgeHandler<Path>): this
  patch(path: string, a: BodySchema<unknown> | EdgeHandler, b?: EdgeHandler): this {
    return this.#bodyRoute("PATCH", path, a, b)
  }

  delete<const Path extends string, Body>(
    path: Path,
    schema: BodySchema<Body>,
    handler: EdgeHandler<Path, Body>,
  ): this
  delete<const Path extends string>(path: Path, handler: EdgeHandler<Path>): this
  delete(path: string, a: BodySchema<unknown> | EdgeHandler, b?: EdgeHandler): this {
    return this.#bodyRoute("DELETE", path, a, b)
  }

  /** Shared body-verb registration: build the entry WITHOUT a `bodySchema` key when there is none,
   * rather than setting it to `undefined` - the schema-present branch is the only one that pays for
   * the validation lane. */
  #bodyRoute(
    method: Method,
    path: string,
    a: BodySchema<unknown> | EdgeHandler,
    b?: EdgeHandler,
  ): this {
    if (typeof a === "function") return this.#route(method, path, { handler: a })
    return this.#route(method, path, { bodySchema: a.body, handler: b as EdgeHandler })
  }

  /** The fetch handler. Not bound - use {@link toFetchHandler} (re-exported) or wrap it yourself. */
  fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const match = this.#router.find(request.method, url.pathname)
    if (!match.found) {
      // Distinguish a wrong method (405 + `Allow`) from a missing route (404), exactly as the full
      // Server does - a naked router would collapse both to 404.
      if (match.reason === "method-not-allowed") {
        return render(plainError(405, "method_not_allowed", { allow: match.allowed.join(", ") }))
      }
      return render(plainError(404, "not_found"))
    }
    const { bodySchema, handler } = match.payload

    const dispatch = async (body: unknown): Promise<Response> => {
      const c: EdgeContext = {
        request,
        params: match.params,
        body,
        query: () => queryObjectOf(searchOf(request.url)),
        header: (name) => request.headers.get(name),
      }
      let out: unknown
      try {
        out = await handler(c)
      } catch (err) {
        // A handler may throw a `Response` for an early exit; anything else is an internal error.
        if (err instanceof Response) return err
        return render(plainError(500, "internal_error"))
      }
      return out instanceof Response ? out : Response.json(out)
    }

    if (bodySchema === undefined) return dispatch(undefined)

    // The body trust boundary IS the shipped lane: `readBodyFramed` does the content-type dispatch,
    // the bounded read + Content-Length pre-reject, and the prototype-poisoning guard. This layers
    // only the route's own Standard Schema validation on the guarded value.
    return readBodyFramed<Response>(
      request,
      this.#maxBodyBytes,
      this.#protoPoisoning,
      async (parsed) => {
        const result = await bodySchema["~standard"].validate(parsed)
        if (result.issues !== undefined || result.value === undefined) {
          return render(plainValidationError((result.issues ?? []) as ReadonlyArray<StandardIssue>))
        }
        return dispatch(result.value)
      },
      render,
      () => render(plainError(400, "invalid_json")),
    )
  }
}

/** Create a compact edge server. */
export function server(options?: EdgeOptions): EdgeServer {
  return new EdgeServer(options)
}

export type { Method, Params, QueryValue, StandardSchemaV1 }
export { toFetchHandler }
