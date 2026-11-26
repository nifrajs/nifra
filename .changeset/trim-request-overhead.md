---
"@nifrajs/core": patch
"@nifrajs/deno": patch
"@nifrajs/middleware": patch
"@nifrajs/node-engine": patch
"@nifrajs/web": patch
"@nifrajs/web-preact": patch
"@nifrajs/web-react": patch
"@nifrajs/web-svelte": patch
"@nifrajs/workers": patch
---

Reduce request and rendering overhead across runtimes. Let the built-in rate limiter charge its in-memory store synchronously while retaining the public store's Promise interface. Reuse the loaded React server renderer for synchronous rendering of warm pages. Reduce response-framing allocations and connection-wide scans in the experimental Node engine.
