---
"@nifrajs/web": minor
"@nifrajs/client": minor
---

A route can declare a `searchSchema` to receive typed, validated search params in its loader.

Export a Standard Schema as `searchSchema` from a route and the loader's `ctx.search` becomes the parsed
URL query validated against it - typed via `LoaderArgs<typeof app, Env, typeof searchSchema>`. Invalid or
hostile input fails closed to the schema's defaults (never a 500); without a `searchSchema`, `ctx.search`
is the raw parsed query. Validation runs server-side at match time, so a loader that reads `ctx.search`
never parses `window.location.search` by hand.

```ts
export const searchSchema = v.object({ page: v.optional(v.fallback(v.number(), 1), 1) })

export async function loader({ search, api }: LoaderArgs<typeof backend, unknown, typeof searchSchema>) {
  return { rows: await api.reports.list(search).get() } // search.page is a number
}
```

The component-facing `useSearch()` hook and typed `navigate({ search })` follow in a later release.
