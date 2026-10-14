---
"@nifrajs/runner": patch
---

`runRequest` and `runApp` report a `maxBodyChars` that is not a non-negative integer or `Infinity` as the result's `RangeError`, without calling the app. `NaN` disabled truncation: the runner read the whole body, returned it empty, and never returned on an endless one.
