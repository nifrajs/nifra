---
"@nifrajs/web": patch
---

`buildTarget` and `buildTargetVite` refuse a public file whose path matches a file the target writes next to it: `server.js` for the bun, node and deno targets, and `_worker.js` or `_routes.json` for cloudflare. Before, the build overwrote the public file and the built server answered that public path with its own server bundle.
