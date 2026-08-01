---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/client": minor
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

`useSearch` ships for React; the other adapters and a typed `navigate({ search })` follow in a later release.
