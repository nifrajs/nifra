---
"@nifrajs/web": patch
"@nifrajs/web-vue": patch
"@nifrajs/web-solid": patch
---

A production server bundle checks NODE_ENV at build time, not on each request, in partial prerendering,
the Vue adapter's streamed render and the Solid adapter's error serialization. On Node each such read
went to the process environment.
