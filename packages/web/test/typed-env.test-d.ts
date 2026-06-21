/**
 * Type-level contract for `createWebApp<Env>`'s end-to-end binding typing. Verified by `tsc` (the
 * root program typechecks the per-package test directories), not run. Exported so `noUnusedLocals`
 * treats each assertion as used.
 *
 * The reviewer's gap: `createWebApp` was untyped, so even an app that declared its bindings had an
 * `unknown` `env` at the edge entry — `app.fetch(req, { env })` / `toFetchHandler(app)` accepted any
 * `env`, and reading a binding needed a guard/cast. Threading `Env` through `createWebApp<Env>()`
 * seeds the returned `Server`'s context with `{ env: Env }`, so the edge entry is typed against the
 * declared shape and a binding access needs no cast. The default stays `unknown` (the secure default).
 */
import { type Platform, toFetchHandler } from "@nifrajs/core"
import type { Equal, Expect } from "@nifrajs/test-utils"
import { createWebApp } from "../src/index.ts"

// An app's declared platform bindings — a Workers KV namespace + a secret.
interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}
interface AppEnv {
  readonly MY_KV: KVNamespace
  readonly API_SECRET: string
}

// `RenderAdapter`/`Manifest` are runtime inputs; these test-d files never execute, so a typed
// declaration (`as` an options object) is enough to read the returned app's type. No render happens.
declare const options: Parameters<typeof createWebApp>[0]

// Declared once: `createWebApp<AppEnv>` returns an app whose context carries the typed `env`.
const typedApp = createWebApp<AppEnv>(options)
// Undeclared: the default `Env` is `unknown` — the secure default (validate at the boundary).
const untypedApp = createWebApp(options)

// `app.fetch(req, platform)` types its platform `env` as the declared `Env` — so the edge entry
// (`app.fetch(req, { env })`) is checked against the app's bindings, not `unknown`.
type TypedPlatform = NonNullable<Parameters<typeof typedApp.fetch>[1]>
export type _FetchPlatformIsEnv = Expect<Equal<TypedPlatform, Platform<AppEnv>>>
export type _FetchEnvIsAppEnv = Expect<Equal<TypedPlatform["env"], AppEnv | undefined>>

// The Workers adapter: `toFetchHandler(app)` infers `Env` from the app, so the exported
// `fetch(request, env, ctx)` types `env` as `AppEnv` — the binding flows end-to-end with no cast.
const handler = toFetchHandler(typedApp)
type WorkerEnv = Parameters<typeof handler.fetch>[1]
export type _WorkerEnvIsAppEnv = Expect<Equal<WorkerEnv, AppEnv>>

// The load-bearing proof: a handler body reads a binding off the typed `env` WITHOUT a cast/guard —
// the exact boilerplate (`kvFromEnv`/`readEnvString`) the reviewer wrote to compensate is gone.
// `tsc` checking this function IS the assertion (a stray cast or `unknown` would error here).
export function _bindingAccessNeedsNoCast(env: WorkerEnv): { kv: KVNamespace; secret: string } {
  return { kv: env.MY_KV, secret: env.API_SECRET }
}

// Negative: an undeclared app keeps `env: unknown` — back-compat + secure default. A binding access
// off it would NOT typecheck (it's `unknown`), which is the intended "validate before use" contract.
type UntypedWorkerEnv = Parameters<ReturnType<typeof toFetchHandler<unknown>>["fetch"]>[1]
export type _UntypedEnvIsUnknown = Expect<
  Equal<Parameters<typeof untypedApp.fetch>[1], Platform | undefined>
>
export type _UntypedWorkerEnvIsUnknown = Expect<Equal<UntypedWorkerEnv, unknown>>
