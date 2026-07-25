---
"@nifrajs/web": minor
---

`@nifrajs/web/service-worker` generates a service worker from a build manifest.

```ts
const sw = generateServiceWorker(manifest, { buildId: gitSha, offlineUrl: "/offline" })
```

Opt-in and generated at build time, so an app that never calls it ships nothing.

The generated worker is deliberately narrow, because a service worker outlives a deploy and can hand
one visitor a response produced for another:

- **Only content-hashed assets are precached.** A hashed URL names its bytes, so cache-first is correct
  by construction; unhashed URLs are left to the network.
- **Documents are never cached.** Only navigations that FAIL are answered, and only with the static
  offline page you nominate. Caching HTML is how a worker serves one signed-in user the page rendered
  for another.
- **GET, same-origin, `ok`, not `no-store`.** Everything else goes straight to the network.
- **The cache name carries the build id**, and activation deletes every older cache, so a stale worker
  cannot pin an old build.

Omit `offlineUrl` and a failed navigation simply fails - an offline page you have not written is not
better than a browser error.
