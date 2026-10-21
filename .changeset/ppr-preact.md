---
"@nifrajs/web-preact": minor
---

Experimental partial prerendering on Preact: `Hole` from the new `@nifrajs/web-preact/ppr` subpath places a hole and hydrates an interactive one as its own root, and the adapter renders a hole's HTML with `renderFragment`, its `useId` values under the hole's own prefix.
