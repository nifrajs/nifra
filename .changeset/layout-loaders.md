---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-vue": minor
"@nifrajs/web-svelte": minor
"@nifrajs/web-vanilla": minor
---

Layout loaders: request data in the component that wraps every page.

`routes/_layout.tsx` rendered, but a `loader` it exported never ran, so nothing request-derived could
reach a layout - host, session, locale, feature flags, tenant. An app hit this and moved its host guard
out of the component tree into the server entry, where it could not be typechecked with the rest of the
app. That is the real cost: the gap pushed security-relevant code to the one place nifra's typed-boundary
promise does not reach. Remix, React Router and SvelteKit all support this; nifra was alone in not.

```tsx
// routes/orgs/[org]/_layout.tsx
export const gate = true                       // optional; see below
export async function loader({ params, req }) {
  return { org: await findOrg(params.org) }    // params is { org } — nothing deeper
}
export default function Layout({ data, children }) { … }
```

**Scoped, not global.** A layout owns the URL prefix it wraps, so it receives only the params inside
that prefix and its loader is skipped on a navigation that did not change them. Navigating
`/orgs/acme/a` → `/orgs/acme/b` does not re-run the org layout's loader. Scope is derived at build time
per `(route, layout)` pair, because one layout can own different params on different expanded patterns:
`[[lang]]/docs/_layout` owns nothing on `/docs/:slug` and `{lang}` on `/:lang/docs/:slug`. Layouts are
not router nodes and did not become any - the router is untouched.

**Execution order is declared, and this matters for security.** By default a layout loader runs in
parallel with the page's, which is right for data and wrong for a guard: a page loader running
concurrently with a guard has already queried by the time the guard says no. `export const gate = true`
makes a layout blocking - nothing beneath it runs until it resolves, and nothing beneath a rejected gate
runs at all. **A layout loader without `gate: true` is not an authorization boundary.** Gates also run on
the data-only request, so a client navigation cannot bypass one by sending the data header, and a gate is
never skipped by the retention hint.

A layout may throw `notFound()` / `gone()` / `redirect()`. Its errors resolve to the `_error` boundary at
or above its OWN segment, never one below it - rendering there would wrap the boundary in the very layout
whose loader just failed.

Every adapter passes each layout its own data. A layout with no loader receives `null`, and an app where
no layout has a loader emits byte-identical HTML and unchanged props.

The data-mode response becomes a versioned envelope when a chain carries layout data. It is recognised
by structure, and the bare pre-envelope shape is still accepted - a prerendered `_data.json` is a static
file that outlives the deploy that wrote it.
