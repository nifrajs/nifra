---
"@nifrajs/web": major
---

feat(web)!: Vercel builds use the Build Output API, and generated entries pass the client address

- The `vercel` target emits the Build Output API v3 layout: `config.json`, `static/` (assets and
  public files) and an edge function at `functions/index.func/`, ready for `vercel deploy --prebuilt`.
  `planBuildTarget` reports the new `outputFile` and a `staticDir` for every target.
- The generated Bun, Node and Deno server entries pass the socket peer to `app.fetch`, so
  `c.clientIp` and `rateLimit`'s default key work in a built app.
- Edge bundles (`cloudflare`, `vercel`) accept `node:async_hooks`, `node:buffer`, `node:events`,
  `node:util` and `node:assert`, which those runtimes provide.
