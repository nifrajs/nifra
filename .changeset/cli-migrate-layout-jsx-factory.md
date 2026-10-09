---
"@nifrajs/cli": patch
---

`nifra migrate layout` keeps the import a page's classic JSX compiles to. A route written with a `/** @jsx h */` pragma lost `import { h } from "preact"` when its loader moved to the backend half, because no identifier in the page names `h`. JSX now counts as a use of the `@jsx` and `@jsxFrag` pragma bindings, or of `React` when the file sets neither and no `@jsxImportSource`.
