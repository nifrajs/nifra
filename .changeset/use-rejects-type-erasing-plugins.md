---
"@nifrajs/core": minor
"@nifrajs/web": patch
---

`.use(plugin)` no longer silently collapses the app's typed route registry to `any` when a plugin's own
types are unpinned. A plugin whose parameter and return infer as `Server<any, any>` - an auth or router
plugin that widened - now makes `.use()` return the non-callable `PluginTypeCollapsed` marker at the
call site, rather than an `any` that only surfaces hundreds of lines away as `never`/`any` in the typed
client. Build the plugin with `defineIdentityPlugin`/`defineContextPlugin`, or pin its input server
type, and it threads the caller's registry and context unchanged.

`serverFunctions()` now ships as such an identity plugin, so `app.use(serverFunctions(...))` keeps every
route declared before and after it fully typed.
