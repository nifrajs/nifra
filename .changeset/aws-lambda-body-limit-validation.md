---
"@nifrajs/aws-lambda": patch
---

`handle` and `streamHandle` validate `maxBodyBytes` at wire-up: a `NaN`, fractional, or negative value
throws a `RangeError` instead of being installed as a cap. `NaN` compares false against every size, so
the misconfiguration read as "configured" while enforcing nothing.
