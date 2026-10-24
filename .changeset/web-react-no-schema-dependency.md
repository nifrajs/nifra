---
"@nifrajs/web-react": patch
---

`@nifrajs/web-react` no longer depends on `@nifrajs/schema`. Its one use was the props schema of the
nested server-component host, which is now a closed Standard Schema written out by hand, so a React
app no longer installs `@nifrajs/schema` and TypeBox unless it uses them.
