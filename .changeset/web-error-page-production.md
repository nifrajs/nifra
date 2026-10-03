---
"@nifrajs/web": patch
---

In production a server-rendered `_error` page receives `{ name: "Error", message: "Internal Server Error" }` instead of the thrown error's own name and text, which can carry a connection string or a query. Development still shows the real error.
