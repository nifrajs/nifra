---
"@nifrajs/core": patch
---

Reuse the unobserved JSON renderer for general-path responses with untouched response controls and no response hooks. This avoids unnecessary rendering bookkeeping for both reads and writes without skipping lifecycle hooks, validation, or error boundaries. On Node, `app.fetch` builds these JSON responses from the serialized string and a prebuilt init instead of undici's slower `Response.json`.
