---
"@nifrajs/web": patch
---

On Windows, the Bun build's `import.meta.glob` applies its `!` exclusions and its `node_modules` skip, and leaves the importing module out of its own matches: it matches every path with forward slashes, since a glob reads `\` as an escape.
