---
"@nifrajs/web-vue": minor
---

Experimental partial prerendering on Vue: `Hole` from the new `@nifrajs/web-vue/ppr` subpath places a hole, with an `error` slot for a failed loader, and hydrates an interactive one as its own app, which keeps its state when the page reloads the hole. A hole's `render` and `fallback` are `h()` output. The adapter renders a hole's HTML with `renderFragment`, its `useId` values under the hole's own prefix.
