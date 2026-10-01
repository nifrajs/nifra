/** Type-level contract for `all()` and `method()`. Checked by `tsc`, not run. */
import type { Equal, Expect } from "@nifrajs/test-utils"
import type { Context, Method, Server, StandardSchemaV1 } from "../src/index.ts"
import { server } from "../src/index.ts"
import { all, method } from "../src/server/methods.ts"

type RegistryOf<S> = S extends Server<infer R> ? R : never

declare const nameBody: StandardSchemaV1<{ name: string }, { name: string }>

// --- all() ----------------------------------------------------------------------------------
const everything = server()
  .derive(() => ({ user: { id: "u1" } }))
  .get("/health", () => ({ ok: true }))
  .use(
    all("/echo/:id", (c) => {
      const id: string = c.params.id
      // The derived context reaches the handler.
      const user: { id: string } = c.user
      // @ts-expect-error - not a param of this path
      c.params.other
      return { id, user: user.id }
    }),
  )
  .use(all("/named", { body: nameBody }, (c) => ({ name: c.body.name })))

type AllReg = RegistryOf<typeof everything>

export type _AllKeys = Expect<Equal<keyof AllReg, "/health" | "/echo/:id" | "/named">>
export type _AllMethods = Expect<Equal<keyof AllReg["/echo/:id"], Method>>
export type _AllOutput = Expect<
  Equal<AllReg["/echo/:id"]["PATCH"]["output"], { id: string; user: string }>
>
export type _AllBody = Expect<Equal<AllReg["/named"]["POST"]["body"], { name: string }>>
// Routes registered before the plugin keep their own shape.
export type _Kept = Expect<Equal<keyof AllReg["/health"], "GET">>
// The builder is still usable after the plugin.
export const _chained = everything.get("/after", (c) => ({ user: c.user.id }))

// --- method() -------------------------------------------------------------------------------
const named = server()
  .decorate("db", { get: (key: string) => key })
  .use(method("PROPFIND", "/dav/*path", (c) => ({ path: c.params.path, row: c.db.get("k") })))
  .use(method(["GET", "post"], "/search", (c) => ({ q: c.query.get("q") })))
  .use(method(["PURGE", "DELETE"], "/cache/:key", { body: nameBody }, (c) => c.body))

type NamedReg = RegistryOf<typeof named>

// A custom token adds nothing to the typed registry: there is no typed-client call for it.
export type _NamedKeys = Expect<Equal<keyof NamedReg, "/search" | "/cache/:key">>
// Names are registered uppercase.
export type _Search = Expect<Equal<keyof NamedReg["/search"], "GET" | "POST">>
// A list with a custom token keeps its standard methods.
export type _Cache = Expect<Equal<keyof NamedReg["/cache/:key"], "DELETE">>
export type _CacheOutput = Expect<
  Equal<NamedReg["/cache/:key"]["DELETE"]["output"], { name: string }>
>

// --- inside a group -------------------------------------------------------------------------
const grouped = server().group("/api", (api) => api.use(all("/ping", () => ({ pong: true }))))

export type _Grouped = Expect<Equal<keyof RegistryOf<typeof grouped>, "/api/ping">>

// --- a plugin built apart from an app -------------------------------------------------------
// It is typed against the base context, so it applies to any app.
const standalone = all("/standalone", (c) => ({ url: c.req.url }))
const applied = server()
  .derive(() => ({ user: { id: "u1" } }))
  .use(standalone)
export type _Standalone = Expect<Equal<keyof RegistryOf<typeof applied>, "/standalone">>

// A handler that needs context the base does not have is refused where it is written.
// @ts-expect-error - `user` is not part of the base context
export const _needsUser = all("/u", (c: Context<"/u"> & { user: { id: string } }) => c.user.id)
