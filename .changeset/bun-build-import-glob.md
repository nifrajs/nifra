---
"@nifrajs/web": minor
"@nifrajs/cli": patch
---

The Bun production build (`buildClient`, `buildServer`, `nifra build`) and the `nifra dev --bun` client expand `import.meta.glob` the way Vite does, through the new `importGlobPlugin` in `@nifrajs/web/build`. A literal pattern, or an array of them, starting with `./`, `../` or `/` (the app root) with `!` exclusions becomes an object keyed as Vite keys it, of lazy `() => import(...)` loaders or, with `eager: true`, the modules themselves; `import: "default"` (or a name) picks one export, and `typeof import.meta.glob` reads `"function"`. A mention in a comment, a string or JSX text is left as written. A computed pattern, an alias or another option fails the build naming the file and line, and a client bundle that still calls `import.meta.glob` (a module another plugin loaded first) is refused instead of shipping a glob that loads nothing.
