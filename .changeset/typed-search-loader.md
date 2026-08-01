---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-vue": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-svelte": minor
"@nifrajs/client": minor
"@nifrajs/cli": minor
---

Typed, validated search params: a route declares a `searchSchema` and both its loader and its component read the parsed, validated query.

Export a Standard Schema as `searchSchema` from a route. The loader's `ctx.search` becomes the parsed URL query validated against it (typed via `LoaderArgs<typeof app, Env, typeof searchSchema>`), and the component reads the same value with `useSearch<typeof searchSchema>()`. Invalid or hostile input fails closed to the schema's defaults (never a 500); without a `searchSchema`, both are the raw parsed query. Validation runs at match time and the value is derived identically on the server and on client navigation, so a component never parses `window.location.search` by hand and the query it renders hydrates with no mismatch.

```tsx
export const searchSchema = v.object({ page: v.optional(v.fallback(v.number(), 1), 1) })

export async function loader({ search, api }: LoaderArgs<typeof backend, unknown, typeof searchSchema>) {
  return { rows: await api.reports.list(search).get() } // search.page is a number
}

export default function Reports({ data }) {
  const { page } = useSearch<typeof searchSchema>() // page: number, SSR-correct
  return <Pager page={page} />
}
```

A `_layout` can declare its own `searchSchema` for keys shared across a section (`?org`, `?theme`); the route's effective search merges the layout chain's schemas with the page's, page-wins on a conflict, so both the layout and the page read their validated slice from one object.

A route can also list `searchClientKeys` - search keys that are purely client-side UI (`?tab`, a client-side `?sort`, `?modal`). When a client navigation changes only those keys, the URL updates (so `useSearch` re-renders) without re-running the loader; any other key change revalidates as before, so data is never stale.

`useSearch` ships on every adapter - React (a value), Preact (a value), Vue (a `Ref`), Solid (an `Accessor`), and Svelte (an accessor), each in that framework's own shape.

`navigate` gains an object form on every adapter: `navigate({ to, search, replace })` serializes `search` onto `to` (no hand-built query strings). Run `nifra sync-routes` to generate `nifra-routes.d.ts` (each static route mapped to its schema output) and include it in your tsconfig, and `search` is typed against the target route's `searchSchema` - a wrong shape for a known route is a compile error, while an unmapped path takes a loose `search`. Regenerated from the route files, so a stale shape becomes a `tsc` error. The string-path and history-delta forms are unchanged.

```ts
navigate({ to: "/reports", search: { page: 2 } }) // search typed against /reports's schema
```
