---
"@nifrajs/web": patch
---

The output guard projects each object of loader, action and server-function data with code generated for that object schema's declared keys, which halves the projection's per-request cost on Bun and Node. It keeps and drops exactly the keys it did before. Edge bundles, browser pages and runtimes that refuse code generation project as before.
