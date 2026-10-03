---
"@nifrajs/cli": patch
---

`nifra fix --code NF-S002` rewrites every flagged comparison in a file in one pass, found from the syntax tree rather than the reported line. A file with several comparisons, a property operand such as `headers.signature`, or a `"use server"` directive now comes out correct, and an existing `timingSafeEqual` import no longer collides with the added helper.
