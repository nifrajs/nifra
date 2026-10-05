/**
 * `all()` and `method()`. A method with no route on a path is still a `405`, and a runtime's HTTP
 * parser may refuse a token it does not know before the server sees the request.
 */
import { RouteConfigError } from "../errors.ts"
import { isRegistrableMethod, METHODS, type Method } from "../router/router.ts"
import type { RouteSchema } from "./context.ts"
import type { MethodRoutesPlugin } from "./plugin.ts"
import type { OutputOf } from "./registry.ts"
import type { Handler } from "./server.ts"

export type { MethodRoutesPlugin } from "./plugin.ts"

/** The part of a server these plugins use: one atomic batch registration. */
interface RouteHost {
  registerBatch(
    routes: readonly {
      readonly method: string
      readonly path: string
      readonly schema: RouteSchema | undefined
      readonly handler: (context: never) => unknown
    }[],
  ): void
}

type ErasedHandler = (context: never) => unknown

const ASCII_NAME = /^[A-Za-z0-9-]+$/

function plugin(
  methods: readonly string[],
  path: string,
  schemaOrHandler: RouteSchema | ErasedHandler,
  handler: ErasedHandler | undefined,
): (app: RouteHost) => RouteHost {
  const schema = handler === undefined ? undefined : (schemaOrHandler as RouteSchema)
  const run = handler ?? schemaOrHandler
  if (typeof run !== "function") throw new TypeError("a route needs a handler function")
  const routes = methods.map((method) => ({ method, path, schema, handler: run }))
  return (app) => {
    app.registerBatch(routes)
    return app
  }
}

/**
 * Register one handler under every standard method: `app.use(all(path, handler))`.
 *
 * ```ts
 * import { all } from "@nifrajs/core/methods"
 *
 * const app = server().use(all("/echo", (c) => ({ method: c.req.method })))
 * ```
 *
 * It is the same as calling `get`, `post`, `put`, `patch`, `delete`, `head` and `options` with the
 * one handler, as a single registration: a method already registered on the path makes the call
 * throw and adds nothing. A schema applies to every method, so with a `body` schema a request that
 * carries no body is refused under any of them, `GET` included.
 */
export function all<
  Path extends string,
  S extends RouteSchema,
  H extends Handler<Path, S, Ctx>,
  Ctx = NonNullable<unknown>,
>(path: Path, schema: S, handler: H): MethodRoutesPlugin<Method, Path, S, OutputOf<H>, Ctx>
export function all<
  Path extends string,
  H extends Handler<Path, RouteSchema, Ctx>,
  Ctx = NonNullable<unknown>,
>(path: Path, handler: H): MethodRoutesPlugin<Method, Path, Record<never, never>, OutputOf<H>, Ctx>
export function all(
  path: string,
  schemaOrHandler: RouteSchema | ErasedHandler,
  handler?: ErasedHandler,
): unknown {
  return plugin(METHODS, path, schemaOrHandler, handler)
}

/**
 * Register one handler under the method, or the methods, you name:
 * `app.use(method("PROPFIND", path, handler))`.
 *
 * ```ts
 * import { method } from "@nifrajs/core/methods"
 *
 * const app = server()
 *   .use(method("PROPFIND", "/dav/*path", (c) => listing(c.params.path)))
 *   .use(method(["GET", "POST"], "/search", (c) => search(c.req)))
 * ```
 *
 * A name is case-insensitive and is registered uppercase. It must be a token of letters, digits and
 * hyphens that starts with a letter, at most 32 characters, and not `TRACE`, `CONNECT` or `TRACK`;
 * anything else throws when `method()` is called. A list is one registration: every method is added,
 * or none is.
 *
 * Only the standard methods among the names join the app's typed registry, so the typed client has
 * a call for those and none for a custom token.
 */
export function method<
  const M extends string,
  Path extends string,
  S extends RouteSchema,
  H extends Handler<Path, S, Ctx>,
  Ctx = NonNullable<unknown>,
>(
  name: M | readonly M[],
  path: Path,
  schema: S,
  handler: H,
): MethodRoutesPlugin<M, Path, S, OutputOf<H>, Ctx>
export function method<
  const M extends string,
  Path extends string,
  H extends Handler<Path, RouteSchema, Ctx>,
  Ctx = NonNullable<unknown>,
>(
  name: M | readonly M[],
  path: Path,
  handler: H,
): MethodRoutesPlugin<M, Path, Record<never, never>, OutputOf<H>, Ctx>
export function method(
  name: string | readonly string[],
  path: string,
  schemaOrHandler: RouteSchema | ErasedHandler,
  handler?: ErasedHandler,
): unknown {
  const names = typeof name === "string" ? [name] : name
  if (!Array.isArray(names) || names.length === 0) {
    throw new RouteConfigError("INVALID_METHOD", "method() needs a method name or a list of them")
  }
  const methods = names.map((value: unknown) => {
    // Checked before the case fold: a letter outside ASCII can fold to an ASCII one.
    const upper = typeof value === "string" && ASCII_NAME.test(value) ? value.toUpperCase() : ""
    if (!isRegistrableMethod(upper)) {
      throw new RouteConfigError(
        "INVALID_METHOD",
        `unsupported HTTP method ${JSON.stringify(value)}`,
      )
    }
    return upper
  })
  return plugin(methods, path, schemaOrHandler, handler)
}
