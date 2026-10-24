---
"@nifrajs/web": minor
"@nifrajs/web-react": patch
"@nifrajs/web-preact": patch
"@nifrajs/web-vue": patch
"@nifrajs/web-svelte": patch
"@nifrajs/web-solid": patch
---

A reload of a path on screen keeps the identity of the parts of its data that it did not change. This covers an action's revalidation, `invalidate()`, the paths an action names with `revalidate()`, a live refresh, a fetcher loading its path again, and a target an intercept boundary holds. Plain objects and arrays compare by content, Dates by time, and array elements with an `id` pair by it, so a prepend or a reorder keeps every unchanged row, and each earlier element is kept for at most one new one; an array whose first 32 elements keep nothing is taken whole, later unchanged elements included. A plain JSON response with the same text as the one the page was read from reuses the page's data without parsing it; a response with deferred parts is always parsed. An unchanged reload publishes only its `pending` flag.

A page exports `shareData = false` to get fresh data on every reload. `FetchRouteData` takes an optional seventh argument, `read` (a `DataText`), after `purpose` and `hosts`, that a custom transport may ignore; the same-text skip then does not apply, while sharing still does.

The adapters' client mounts take advantage of it. React and Preact render each layout and the page memoized on its own props, with a layout's children read through context, so an unchanged reload re-renders neither a layout nor a memoized row. Vue passes each layout the next level as a stable slot. Svelte and Solid derive `data` and the layouts' data with an identity check, so an effect on them runs again only when a reload changed them; Solid's `<For>` then keeps every unchanged row and its DOM state. Svelte pages receive `data` as the router published it rather than as a deep reactive proxy of it. React, Preact and Vue keep `search` as the same object while the query is the same.
