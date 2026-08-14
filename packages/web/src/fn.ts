/**
 * `@nifrajs/web/fn` - server functions: write a function, call it from a component.
 *
 * ## Every server function is a public endpoint
 *
 * This is the first thing to internalise, because the API deliberately reads like a local call. A
 * mounted function is an HTTP route anyone can POST to, with arguments entirely under the caller's
 * control. Its id has to be in the client bundle for the browser to call it, so there is no obscurity
 * to lean on. Treat one exactly as you would a hand-written `app.post`.
 *
 * What follows from that, and what this module does about it:
 *
 *   - **Input is validated, always.** `input` is not optional decoration; without a schema a function
 *     takes no arguments at all. Unvalidated arguments on a public endpoint are mass assignment.
 *   - **`application/json` only.** A cross-origin HTML form can only send urlencoded, multipart or
 *     text/plain, so requiring JSON forces a CORS preflight the browser blocks. Both alternatives were
 *     measured rather than assumed: a body schema alone still accepts a cross-origin urlencoded form
 *     (200, attacker-controlled fields), and `c.boundedJson` alone accepts the `text/plain` trick where
 *     a form's `name=value` is crafted to parse as JSON. Neither is sufficient by itself.
 *   - **Same-origin only.** A present `Origin` must match the request's own host. Defence in depth
 *     behind the JSON requirement, and it costs one comparison. Server functions exist for your own
 *     frontend; a different origin calling your backend is the typed-client story, not this one.
 *   - **No closures.** A function is a module-level export taking explicit arguments. Next serialises
 *     closed-over variables to the browser and back, which it now has to encrypt; refusing the feature
 *     removes the whole class rather than defending it.
 *
 * ## The client half
 *
 * A `*.fn.ts` module is never bundled for the browser. The client build replaces it with one stub per
 * export, each POSTing to the route below, so the bodies and everything they import stay on the server.
 *
 * Every pipeline applies this - `nifra dev --bun` included. Bun's dev-server bundler accepts plugins
 * only through bunfig `[serve.static]` (a runtime `Bun.plugin` onLoad does not reach it, measured
 * rather than assumed), so that command generates a config under `.nifra/dev-bun/` carrying this
 * same stub plugin and relaunches itself with `--config=` pointing at it; the launch is verified
 * with a per-run token and refuses to serve if the boundary cannot be proven active. Identical
 * stubs across `nifra build`, `nifra dev` (Vite), and `nifra dev --bun`.
 *
 * ## Why this is not a new lane
 *
 * A mounted function registers through the ordinary public `register()`, so it is a route like any
 * other and inherits the body cap, schema validation, capability declarations, the effect ledger, and
 * `nifra assure`. Nothing here touches the kernel or the request path, so an app that mounts none of
 * them pays exactly nothing - which is the whole reason to build it this way rather than as a
 * bespoke dispatcher.
 */
import {
  type AnyServer,
  type Context,
  defineIdentityPlugin,
  type IdentityPlugin,
  isSameOriginRequest,
  type RouteSchema,
  type StandardSchemaV1,
} from "@nifrajs/core/server"

/** The URL prefix every mounted function lives under. Namespaced per mount, then by export name. */
export const SERVER_FN_PREFIX = "/_nifra/fn"

type MaybePromise<T> = T | Promise<T>

/** What a server function declares about itself. */
export interface ServerFnConfig<Input> {
  /**
   * Validates the single argument. Omit it and the function takes no argument - never "any argument":
   * the caller controls this value completely, so an unvalidated one is an open door.
   */
  readonly input?: StandardSchemaV1<unknown, Input>
  /** Effect tokens, forwarded to the route so `nifra assure` and the effect ledger see them. */
  readonly capabilities?: readonly string[]
}

/**
 * A declared server function. Callable directly on the server (the same value your own server-side
 * code can await); on the client, phase 2's build transform replaces this module with typed stubs
 * that POST to the mounted route.
 *
 * This is the SERVER declaration type, so context is required. Client builds replace the module with
 * a one-argument {@link ClientServerFn}; UI bindings accept either shape and adapt at that boundary.
 * Keeping the types separate prevents a direct server call from type-checking while handing the
 * declaration `undefined` for a context its implementation requires.
 */
export interface ServerFn<Input, Output> {
  (input: Input, context: Context): MaybePromise<Output>
  readonly [SERVER_FN]: ServerFnConfig<Input>
}

/** The one-argument callable emitted into a client bundle for a {@link ServerFn}. */
export type ClientServerFn<Input, Output> = (input: Input) => MaybePromise<Output>

/** A UI binding boundary: source declarations and generated client stubs are both accepted. */
export type ServerFnReference<Input, Output> =
  | ServerFn<Input, Output>
  | ClientServerFn<Input, Output>

/** Brand identifying a value produced by {@link serverFn}, so mounting cannot pick up stray exports. */
export const SERVER_FN: unique symbol = Symbol.for("@nifrajs/web/server-fn")

/**
 * Declare a server function.
 *
 *     export const addTodo = serverFn(
 *       { input: t.object({ text: t.string({ minLength: 1 }) }), capabilities: ["db.write"] },
 *       async ({ text }, c) => db.todos.insert({ text }),
 *     )
 *
 * The second argument receives the validated input and the ordinary nifra `Context` - `c.env`,
 * `c.clientIp`, `c.budget`, cookies, and the capability guard are all present, because this is a route.
 */
export function serverFn<Input = void, Output = unknown>(
  config: ServerFnConfig<Input>,
  fn: (input: Input, context: Context) => MaybePromise<Output>,
): ServerFn<Input, Output> {
  return Object.assign(fn, { [SERVER_FN]: config }) as ServerFn<Input, Output>
}

const isServerFn = (value: unknown): value is ServerFn<unknown, unknown> =>
  typeof value === "function" && SERVER_FN in (value as object)

/** A namespace segment: lowercase, dot/dash separated. Constrained so a mount cannot invent a path. */
const NAMESPACE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/
/** An export name that is safe in a URL path without escaping. */
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Same-origin, from `@nifrajs/core` so this seam and the WebSocket handshake cannot answer differently
 * for one request. Host must match; the Origin's scheme may be equal or stronger, never weaker - which
 * is what keeps a TLS-terminating proxy working without reading a forwarded header.
 */
const sameOrigin = isSameOriginRequest

/** The minimum a server needs to expose for functions to be mounted onto it. */
export interface ServerFnHost {
  register(
    method: "POST",
    path: string,
    schema: RouteSchema | undefined,
    handler: (context: never) => unknown,
  ): void
}

/** Every server function a module exports, keyed by export name. */
export type ServerFnModule = Readonly<Record<string, unknown>>

/**
 * Mount a module's server functions under `namespace`, returning a plugin for `app.use(...)`.
 *
 *     import * as todos from "./actions/todos.fn"
 *     app.use(serverFunctions("todos", todos))   // -> POST /_nifra/fn/todos/addTodo
 *
 * The namespace is explicit rather than derived from the file path: a path-derived one would put the
 * build machine's layout in a public URL, and this keeps the route readable in logs and greppable in
 * the codebase. Phase 2's transform supplies it automatically from the file's location in the project.
 *
 * Exports that are not server functions are ignored, so `export type` and helpers can live alongside.
 */
export function serverFunctions(namespace: string, module: ServerFnModule): IdentityPlugin {
  if (!NAMESPACE.test(namespace)) {
    throw new Error(
      `[nifra/fn] invalid server-function namespace ${JSON.stringify(namespace)} - use lowercase dot/dash segments (it becomes a URL path).`,
    )
  }
  const mounted = Object.entries(module).filter(
    (entry): entry is [string, ServerFn<unknown, unknown>] => isServerFn(entry[1]),
  )

  const apply = <S extends AnyServer>(app: S): S => {
    for (const [name, fn] of mounted) {
      if (!EXPORT_NAME.test(name)) {
        throw new Error(
          `[nifra/fn] server function ${JSON.stringify(name)} in namespace ${JSON.stringify(namespace)} is not a valid identifier.`,
        )
      }
      const config = fn[SERVER_FN]
      const schema: RouteSchema = {
        ...(config.input !== undefined ? { body: config.input } : {}),
        ...(config.capabilities !== undefined ? { capabilities: config.capabilities } : {}),
      }
      app.register("POST", `${SERVER_FN_PREFIX}/${namespace}/${name}`, schema, ((c: Context) => {
        // Ordered cheapest-first, and BEFORE the declared function runs. The body has already been
        // parsed by the schema layer, but parsing is not a side effect - nothing the caller asked for
        // has happened yet, so rejecting here is a complete refusal.
        const request = c.req
        const contentType = request.headers.get("content-type") ?? ""
        if (!contentType.includes("application/json")) {
          // A form cannot send this content type cross-origin without a preflight. Rejecting anything
          // else is what makes form-driven CSRF against a server function impossible rather than
          // merely unlikely.
          return c.json({ ok: false, error: "unsupported_media_type" }, 415)
        }
        const origin = request.headers.get("origin")
        if (origin !== null && !sameOrigin(origin, request)) {
          return c.json({ ok: false, error: "forbidden_origin" }, 403)
        }
        return fn(config.input === undefined ? (undefined as never) : (c.body as never), c)
      }) as (context: never) => unknown)
    }
    return app
  }
  return defineIdentityPlugin(`nifra:server-fn:${namespace}`, apply)
}
