---
"@nifrajs/core": minor
"@nifrajs/client": patch
---

Sharper types + names for two footguns hit building on Nifra.

- **`defineRouterPlugin`** — a clearer-named alias of `defineIdentityPlugin` for a plugin that mounts routes/hooks but adds **no context type** (an auth router, an audit logger). `definePlugin`'s docs now loudly warn that using it for such a plugin silently collapses the typed client to `any` (no type error, no runtime error). The plugins guide leads with `defineRouterPlugin` and shows the side-effect-then-`return app` mount pattern.
- **Better error when a route has no `query` schema.** Passing `query` to such a route via the typed client now fails with a message that reads out the fix — `add a \`query\` schema to this route — { query: z.object({ … }) } — so the typed client can accept query params here` — instead of the opaque `not assignable to type 'never'`. The error surfaces at the call site; the fix is at the route. Non-breaking: passing query to a schema-less route was already rejected, just unhelpfully.
