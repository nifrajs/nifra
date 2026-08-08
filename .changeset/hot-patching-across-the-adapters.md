---
"@nifrajs/web": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-svelte": minor
"@nifrajs/web-vue": minor
---

Vue, Solid and Svelte hot-patch a component edit in place on the Bun dev pipeline: the page keeps its scroll position, its open dialogs and the rest of its client state, and only the edited component re-renders. Route modules still full-reload on save, since a route carries the loader and meta the server ran. The wiring is emitted for a dev server's client compile only, so nothing reaches a production bundle.

`@nifrajs/web-svelte/plugin` adds `svelteHmrBoundary`, the same boundary for the Vite pipeline - pass it to `@sveltejs/vite-plugin-svelte` as `dynamicCompileOptions`. Svelte's hot-patch wrapper resolves a component through a signal, which reconciles against server markup only where the component is a plain child in a template; a layout or a page is neither, and wrapping one desyncs hydration on first load. The boundary keeps the wrapper on the app's own views. (Svelte recreates the patched component, so its own `$state` restarts - Vue and Solid preserve theirs.)

`Router.svelte` now takes `searchOfChain` from `@nifrajs/web/client` rather than the package root, so a client bundle no longer reaches server-only modules through it.
