---
"@nifrajs/core": minor
"@nifrajs/middleware": minor
"@nifrajs/otel": minor
"@nifrajs/devtools": minor
---

`app.use(plugin)` keeps the caller's server type. A plugin built with `definePlugin` whose input
server type is not pinned used to widen the app to `Server<any, any>`, so every route declared
before *and* after the `use` lost its types and the typed client silently degraded to `any`. That
case is now a compile error at the `use` call site, naming the definer to switch to; the plugin is
unchanged at runtime.

Pick the definer that matches what the plugin does: `defineContextPlugin<D>` when it adds context
via `derive`/`decorate` (the registry threads through and `D` is added to every downstream handler
context), `defineRouterPlugin` when it mounts routes/hooks and adds no context (mount as a side
effect, return the app). `definePlugin` still works when its input type is pinned - annotate the
parameter (`(app: typeof api) => ...`) or pass explicit type arguments.

Every first-party plugin now threads: `jwt`, `tokenAuth`, `basicAuth`, `durableCommand`, `etag`,
`compression`, `problemDetails`, `prettyJson`, `methodOverride`, `trailingSlash`, `cacheControl`,
`devtools`, and `metrics` return an `IdentityPlugin`; `timing`, `language`, and `tracing` return a
`ContextPlugin` of what they add (`{ timing }`, `{ language, languageMatch }`, and
`{ trace, observation, causality }` respectively), so `c.timing` / `c.language` / `c.trace` are
typed without a manual annotation. `combine(...)` is typed as an identity bundle and
`namedCombine(name, ...)` is its deduped, named form.

A type-level test asserts the threading for each definer shape, so a regression fails `typecheck`
rather than surfacing as `any` in a downstream app.
