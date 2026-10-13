---
"@nifrajs/cli": patch
---

`nifra migrate layout` follows a top-level `const dir = import.meta.dir` (or `import.meta.dirname`, `__dirname`) the way it follows the expression itself: `resolve(dir, "src/x.tsx")`, `join(dir, ...)`, `dir + "/x"` and `` `${dir}/x` `` are re-pointed when the file they name moves, in a module that moves and in one that stays, such as a root build script. A name the file also declares elsewhere is left alone and reported.
