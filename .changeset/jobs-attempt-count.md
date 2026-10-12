---
"@nifrajs/jobs": patch
---

`define({ retries })`, `define({ retries: { attempts } })` and `createQueue({ defaultAttempts })` now throw a `RangeError` for an attempt count that is not a whole number. Before, `retries: NaN` (or a `NaN` default) made the attempt limit `NaN`, so a failing job was retried forever and never dead-lettered. A count below 1 still means one attempt.
