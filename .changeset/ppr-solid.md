---
"@nifrajs/web-solid": minor
---

Experimental partial prerendering on Solid: `Hole` from the new `@nifrajs/web-solid/ppr` subpath places a hole and hydrates an interactive one as its own root, which keeps its state when the page reloads the hole. A hole's `render` returns JSX and its `fallback` is a function returning JSX. The adapter renders a hole's HTML with `renderFragment` under the hole's own hydration key prefix. Solid's client renders new DOM from plain strings under no Trusted Types policy, so a Solid app cannot enforce Trusted Types.
