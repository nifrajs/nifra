---
"@nifrajs/testing": minor
---

`generateRegressionTest` redacts query values, header values other than `content-type`, and the capsule note by default, not only body strings, and raises the sanitize banner when it does. New `allowQuery`, `allowHeaders` and `keepNote` options keep chosen values verbatim. The emitted file also asks for the path, which is kept verbatim, to be reviewed.
