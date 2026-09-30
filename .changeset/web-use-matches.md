---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-vue": minor
"@nifrajs/web-svelte": minor
---

feat(web): a route can export a `handle`, and `useMatches()` reports the rendered chain on every adapter.

```tsx
// routes/orgs/[org]/_layout.tsx
import { useMatches } from "@nifrajs/web-react/router"

export const handle = { crumb: "Organization" }

export default function OrgLayout({ children }: { children: React.ReactNode }) {
  const crumbs = useMatches().flatMap((m) => (m.handle as { crumb?: string } | undefined)?.crumb ?? [])
  // ...
}
```

`useMatches()` lists the layouts being rendered, outermost first, then the page, each as
`{ id, pathname, params, data, handle }`: the route file without its extension, the part of the URL
it covers (never the query), the params it declares, its loader data (`null` without a loader), and
its `handle` export. The server render and the browser report the same list, so a breadcrumb trail
hydrates with no mismatch. `handle` is read from the module on each side and never serialized.

While a `_loading` page is up it takes the page's place; a nested `_404` reports the layouts it
renders inside; an `_error` page the server renders reports an empty list. The hook ships from each
adapter's `/router` entry: an array on React and Preact, a `Ref` on Vue, an accessor on Solid and
Svelte. An app that never calls it does not bundle it.

The Preact, Solid, Vue and Svelte client mounts now pass `params` and `path` to the rendered chain,
as the server render already did. `UIMatch` and `MatchChain` are exported from `@nifrajs/web`.
