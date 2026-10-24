---
"@nifrajs/web-react": patch
"@nifrajs/web-preact": patch
"@nifrajs/web-solid": patch
"@nifrajs/web-svelte": patch
---

A kept page's two wrappers, `[data-nifra-entry]` and `[data-nifra-page]`, are `<slot>` elements, which browsers lay out as `display: contents`. They carry no inline style, so under a `style-src` without `'unsafe-inline'` they take no box from the first paint and the console reports nothing, and a wrapper inside a `<p>` stays inside it.
