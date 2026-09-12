---
"@nifrajs/web": minor
---

Add a per-request `nonce` resolver to `createWebApp`. Nonces flow through framework-owned document scripts, status pages, error pages, and 404s; nonce-bearing responses are marked `private, no-store` so request-specific CSP values are not replayed from caches.
