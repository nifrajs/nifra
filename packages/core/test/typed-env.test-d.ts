/**
 * Type-level proof that `server<Env>()` types the backend's `c.env` end-to-end: a handler reads a
 * binding off `c.env` WITHOUT a guard/cast, `app.fetch` / `toFetchHandler` type their `env` argument
 * against the declared shape, and an UNDECLARED app keeps `c.env: unknown` (the secure default).
 * Verified by `tsc` (each handler body that reads a typed binding is itself the check), not run.
 */
import { server, toFetchHandler } from "@nifrajs/core"
import type { Equal, Expect } from "@nifrajs/test-utils"

// An app's declared platform bindings — a Workers KV namespace + a secret string.
interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}
interface AppEnv {
  readonly MY_KV: KVNamespace
  readonly API_SECRET: string
}

// Declared once via `server<AppEnv>()`: every handler reads `c.env.MY_KV` / `c.env.API_SECRET` typed,
// no per-binding cast. `tsc` checking this handler body IS the assertion — a stray cast or an
// `unknown` `c.env` (the pre-fix state, which forced `kvFromEnv`/`readEnvString`) would error here.
export const _typedApp = server<AppEnv>().get("/cached", async (c) => {
  const cached = await c.env.MY_KV.get("k") // c.env is AppEnv — direct binding access, no guard
  return { cached, hasSecret: c.env.API_SECRET.length > 0 }
})

// The edge entry types its `env` argument against the declared bindings: `toFetchHandler(app)` infers
// `Env = AppEnv`, so the exported `fetch(request, env, ctx)` types `env` as `AppEnv` end-to-end.
const handler = toFetchHandler(_typedApp)
type WorkerEnv = Parameters<typeof handler.fetch>[1]
export type _WorkerEnvIsAppEnv = Expect<Equal<WorkerEnv, AppEnv>>

// Negative: an UNDECLARED `server()` keeps `c.env: unknown` — back-compat + the secure default. A
// property access off it must NOT typecheck without first narrowing; `@ts-expect-error` proves it's
// `unknown`, not silently `any` (an `any` `c.env` would make this access compile and fail the test).
export const _untypedApp = server().get("/raw", (c) => {
  // @ts-expect-error `c.env` is `unknown` when no `Env` is declared — validate before use.
  const kv = c.env.MY_KV
  return { kv }
})

// And the undeclared edge entry's `env` is `unknown`, not the declared shape.
type UntypedWorkerEnv = Parameters<ReturnType<typeof toFetchHandler<unknown>>["fetch"]>[1]
export type _UntypedWorkerEnvIsUnknown = Expect<Equal<UntypedWorkerEnv, unknown>>
