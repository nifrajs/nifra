---
"@nifrajs/middleware": patch
---

`prettyJson()` passes a response through unchanged when its indented form would outgrow it more than eightfold (with a 64 KiB floor). Indentation repeats the nesting depth on every line, so a few kilobytes of deeply nested JSON, for example a request body an endpoint echoes back, expanded to tens of megabytes. The budget is checked before each line is built, so nothing past it is allocated.
