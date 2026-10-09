---
"@nifrajs/web": patch
---

The client build of a `*.fn.ts` module no longer drops a server function when a string literal before it contains `/*` or `//`. A `serverFn({ accept: "image/*" }, ...)` opened a comment that ran to the next `*/`, so the functions declared in between got no client stub and failed as "not a function".
