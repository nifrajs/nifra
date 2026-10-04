---
"@nifrajs/prompt": patch
---

`run()` refuses a `healAttempts` that is not an integer (such as `NaN` from an unset environment variable, or `Infinity`) with a `RangeError` before the model is called. Previously such a value never reached its bound, and the heal hook ran without end.
