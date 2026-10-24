---
"@nifrajs/web": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-vue": minor
"@nifrajs/web-svelte": minor
"@nifrajs/web-react": patch
---

`keepAlive` routes work with the Preact, Solid and Vue adapters as well as React and Svelte. Each of the three ships `usePageVisibility()`, `onPageHide` and `onPageShow` from its `/router` subpath; Vue keeps pages with its own `<KeepAlive>` and renders no wrapper elements. `@nifrajs/web-svelte/router` gains `usePageVisibility()`, and a `useBlocker` in a hidden Svelte page blocks nothing.

A page left with a route open in a modal is kept with it, and back to that entry opens the modal again. Islands in a kept page can pause with `onPageHide(el, fn)` and `onPageShow(el, fn)` from `@nifrajs/web/islands`. Server components in a kept page stay mounted while it is hidden: `bindComponentRouter` parks them on the page events, and outlets pass their host to `controller.unmount(instance, host)` so a parked page and the page on screen can hold the same instance. A parked component waits for its page, taken back when the page is shown and released when it is dropped; `controller.isParked(instance, host)` tells an outlet whose framework cleans up a hidden page's effects, as React's `<Activity>` does, to leave it parked. In Vue, a layout inside a kept branch reads the branch's visibility, and a page dropped inside a hidden branch unmounts. In Preact, as in React, props a layout adds with `cloneElement` reach a kept page.

The `nifra:pagehide` event fires as the router hides a page, while the page is still in the document and before the router's subscribers see the state that hides it.
