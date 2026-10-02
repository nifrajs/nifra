---
"@nifrajs/web": patch
---

The Bun dev server refuses a backend file of any type that browser code imports, such as a `.sql` or `.pem` file imported `with { type: "text" }`, as the production build does.
