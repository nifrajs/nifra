---
"@nifrajs/core": patch
---

JSON responses on apps with response hooks render faster through `app.fetch` on Node, and Deno builds JSON responses that carry response headers with its native `Response.json`. Bun and Deno servers also check a repeated `Host` header once instead of on every request.
