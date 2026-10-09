---
"@nifrajs/cli": patch
---

`nifra check` treats a module as backend-only only when it imports `@nifrajs/web/backend-only` in code. A mention of that import in a comment or a string, such as a note on how to opt in, no longer makes every route that imports the module fail with a server-only import error.
