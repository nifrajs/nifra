---
"@nifrajs/web": minor
---

feat(web): a layout's `shouldRevalidate` decides whether its loader runs again on a client navigation.

```ts
// routes/orgs/[org]/_layout.backend.ts
export const shouldRevalidate: ShouldRevalidate = ({ currentParams, nextParams }) =>
  currentParams.org !== nextParams.org
```

It receives the URL and params being left (`currentUrl`, `currentParams`), the ones being loaded
(`nextUrl`, `nextParams`, every route param rather than only the layout's own), and
`defaultShouldRevalidate`: `true` when a param the layout owns or the query changed. Returning
`false` keeps the data the browser already holds; any other value, a returned promise included, runs
the loader. A throw fails the navigation the way the loader's own error would.

It runs on the server, on a client navigation that keeps the layout on screen while the browser
holds its data. A document request, the revalidation after an action, and `router.invalidate()` run
every loader without asking. A `gate` layout is never asked: it runs on every request. A page's
`shouldRevalidate` is not read, because a page's loader runs on every navigation; query keys a page
never reads belong in its `searchClientKeys`.

`ShouldRevalidate` and `ShouldRevalidateArgs` are exported from `@nifrajs/web`.
