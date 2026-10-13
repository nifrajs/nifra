---
"@nifrajs/core": minor
---

A route answering `status(code, body)` with a code typed as plain `number` now types the client's `data` as that body; it was `unknown`. A code typed as a literal union (`200 | 409`) still splits into one arm per code. A plain return beside `status(200, body)` now types the 200 arm as either body; the two used to be intersected.
