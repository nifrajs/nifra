---
"@nifrajs/web": patch
---

The Vite dev pipeline no longer serves a stale SSR module after an edit to a file a route imports. Vite
re-evaluates a directly-changed module on its own, but a parent that merely imports the changed leaf
kept its cached SSR bindings, so the re-created app walked a graph that was fresh at the leaf and stale
above it. That surfaced as phantom hydration mismatches (SSR rendered through an old module, the client
through the new one) and stale i18n catalogs. On every change the dev server now evicts the changed file
together with its transitive importer closure from the SSR graph before rebuilding the app, so the next
render re-walks the whole affected subtree. Apps whose only transforms are `vitePlugins` (and are
therefore forced onto the Vite pipeline) get correct hot reloads without a manual restart.
