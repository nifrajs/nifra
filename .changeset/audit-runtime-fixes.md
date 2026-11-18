---
"@nifrajs/core": patch
"@nifrajs/middleware": patch
"@nifrajs/web": patch
"@nifrajs/proxy": patch
---

Fall back to the normal body hook if render-time response construction fails. Preserve bodyless statuses when replaying cached responses. Apply the query cache cap to imperative writes and hydration. Require patched Undici peer versions.
