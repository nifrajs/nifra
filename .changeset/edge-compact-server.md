---
"@nifrajs/edge": minor
"@nifrajs/core": patch
---

New package `@nifrajs/edge`: a compact fetch-handler server for edge and serverless runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy, Bun). It keeps the `server().get().post()` DX and the full request trust boundary - bounded body read, Content-Length pre-reject, prototype-pollution guard, JSON / urlencoded framing - in a fraction of the bundle, and its rejection envelopes are byte-for-byte the full server's, so an app can graduate to `@nifrajs/core`'s `server()` without its clients noticing.
