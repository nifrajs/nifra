---
"@nifrajs/core": patch
"@nifrajs/cli": patch
"@nifrajs/middleware": patch
"@nifrajs/web": patch
"@nifrajs/proxy": patch
---

Fall back to the normal body hook if render-time response construction fails. Preserve bodyless statuses when replaying cached responses. Apply the query cache cap to imperative writes and hydration. Require patched Undici peer versions. Honor promoted diagnostic errors in the CLI verdict and clear evicted query handles when the visitor changes.
