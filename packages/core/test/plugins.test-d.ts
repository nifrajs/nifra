/**
 * Type-level proof that `.use(plugin)` preserves the caller's server type.
 *
 * This is the regression class runtime tests cannot see: when a plugin collapses the server type to
 * `Server<any, any>`, every route still works and every test still passes - the loss only surfaces
 * as `any` in the typed client, often in another package. Verified by `tsc --noEmit`.
 *
 * Each assertion is exported so `noUnusedLocals` treats it as used.
 */
import type { Equal, Expect } from "@nifrajs/test-utils"
import type {
  AnyServer,
  ContextPlugin,
  IdentityPlugin,
  PluginTypeCollapsed,
  Server,
} from "../src/index.ts"
import { defineContextPlugin, defineIdentityPlugin, definePlugin, server } from "../src/index.ts"

type RegistryOf<S> = S extends Server<infer R> ? R : never
type ContextOf<S> = S extends Server<infer _R, infer C> ? C : never
type IsAny<T> = 0 extends 1 & T ? true : false

const app = server()
  .get("/a", () => ({ a: 1 }))
  .post("/b", () => ({ b: 2 }))

type AppRegistry = RegistryOf<typeof app>

// --- identity plugins (routes/hooks, no context) keep the registry AND the context ---
const router = defineIdentityPlugin("router", (a) => a)
const routed = app.use(router)
const afterRouter = routed.delete("/c", () => ({ c: 3 }))

export type _RouterKeepsRegistry = Expect<Equal<RegistryOf<typeof routed>, AppRegistry>>
export type _RouterRegistryNotAny = Expect<Equal<IsAny<RegistryOf<typeof routed>>, false>>
export type _RouterKeepsLaterRoutes = Expect<
  Equal<keyof RegistryOf<typeof afterRouter>, "/a" | "/b" | "/c">
>
export type _RouterKeepsRouteTypes = Expect<
  Equal<RegistryOf<typeof afterRouter>["/a"]["GET"]["output"], { a: number }>
>

// A *declared* identity plugin (the shape a package ships) must thread too - the `& { pluginName }`
// intersection is what used to defeat inference and collapse the result.
declare const shipped: IdentityPlugin & { claims(request: Request): string | null }
const withShipped = app.use(shipped)
export type _ShippedKeepsRegistry = Expect<Equal<RegistryOf<typeof withShipped>, AppRegistry>>

// --- context plugins add D and thread the registry unchanged ---
const requestId = defineContextPlugin<{ requestId: string }>("requestId", (a) =>
  a.derive(() => ({ requestId: "r" })),
)
const withContext = app.use(requestId)

export type _ContextKeepsRegistry = Expect<Equal<RegistryOf<typeof withContext>, AppRegistry>>
export type _ContextAddsD = Expect<Equal<ContextOf<typeof withContext>["requestId"], string>>
export type _ContextNotAny = Expect<Equal<IsAny<ContextOf<typeof withContext>>, false>>

declare const shippedContext: ContextPlugin<{ tenant: string }>
const withShippedContext = app.use(shippedContext)
export type _ShippedContextThreads = Expect<
  Equal<RegistryOf<typeof withShippedContext>, AppRegistry>
>
export type _ShippedContextAddsD = Expect<
  Equal<ContextOf<typeof withShippedContext>["tenant"], string>
>

// --- inline plugin arrows keep threading (contextually typed by the concrete `this`) ---
const inline = app.use((a) => a.decorate("greeting", "hi" as const))
export type _InlineKeepsRegistry = Expect<Equal<RegistryOf<typeof inline>, AppRegistry>>
export type _InlineAddsContext = Expect<Equal<ContextOf<typeof inline>["greeting"], "hi">>

// --- definePlugin with an unpinned input server type must NOT compile at the `.use()` call site ---
const collapsed = definePlugin("collapsed", (a) => a.derive(() => ({ user: "u" })))
// @ts-expect-error definePlugin erased the server type: use defineContextPlugin/defineRouterPlugin
app.use(collapsed)

// --- a hand-rolled plugin whose types collapsed to Server<any, any> (an auth plugin from a package
// that widened - the "#1 reported anti-drift bug") is caught at the `.use()` call site: it returns the
// non-callable PluginTypeCollapsed, NOT `any`, so the widening cannot spread silently to the client. ---
declare const rawCollapsing: (app: AnyServer) => AnyServer
const collapsedRaw = app.use(rawCollapsing)
export type _RawCollapseIsFlagged = Expect<Equal<typeof collapsedRaw, PluginTypeCollapsed>>
export type _RawCollapseNotAny = Expect<Equal<IsAny<typeof collapsedRaw>, false>>

// Pinning the input type is the documented escape hatch and still threads.
const pinned = definePlugin("pinned", (a: typeof app) => a.derive(() => ({ user: "u" })))
const withPinned = app.use(pinned)
export type _PinnedKeepsRegistry = Expect<Equal<RegistryOf<typeof withPinned>, AppRegistry>>
export type _PinnedAddsContext = Expect<Equal<ContextOf<typeof withPinned>["user"], string>>
