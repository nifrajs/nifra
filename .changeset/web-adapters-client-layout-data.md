---
"@nifrajs/web-react": patch
"@nifrajs/web-preact": patch
"@nifrajs/web-vue": patch
"@nifrajs/web-solid": patch
"@nifrajs/web-svelte": patch
---

fix(web-react, web-preact, web-vue, web-solid, web-svelte): a layout keeps its loader data in the
browser. The mounted router rendered every layout with `data: null` - on the first paint, where the
server had rendered the layout with its data and the client render no longer matched it, and after
each client navigation. It now hands each layout the data the router holds for it. On Solid a layout
also follows a same-route update, so new layout data after a revalidation or a param change arrives
without the layout remounting.
