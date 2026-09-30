---
"@nifrajs/web": minor
"@nifrajs/web-react": patch
---

feat(web): `export const ssr = false` keeps a page's component off the server. The route is still
matched, its layouts still render, its gates and loader still run and the data is still embedded;
the server puts the page's `HydrateFallback` export in the page slot - or nothing - and the browser
hydrates that before it renders the component with the data it already has. A client navigation to
the page renders the component directly. `HydrateFallback` receives the component's props. The
module is still imported on the server for its loader and options, so an import that needs a
browser at load time belongs inside the component. `ssr = false` together with `hydrate = false`
is refused when the page is rendered: nothing would render it. On Solid the layouts mount again
when the component takes over from the fallback, as they do on any Solid route change.

`assertRenderAdapterConformance` now also renders a chain whose leaf is a function returning
`null` and requires the layouts around an empty page slot (check `"empty leaf"`). An adapter that
cannot render such a leaf fails conformance.

fix(web-react): the mounted router hydrates against the state it was mounted with. A router that
changed before React reached the component - a client loader that answered first - no longer
hydrates a tree the server markup never had; React renders the newer state right after.
