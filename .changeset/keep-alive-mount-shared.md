---
"@nifrajs/web": patch
"@nifrajs/web-react": patch
"@nifrajs/web-preact": patch
"@nifrajs/web-svelte": patch
"@nifrajs/web-solid": patch
"@nifrajs/web-vue": patch
---

The keep-alive mounts of the React, Preact, Svelte, Solid and Vue adapters take their framework-free half from `@nifrajs/web/internal/keep-alive-mount`. This covers the slot tree of each router state, the parking each committed tree goes to, render props made once per state, and the slots under each layout. Each adapter still renders the slots its own way. Kept pages behave as before.
