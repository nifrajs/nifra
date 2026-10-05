---
"@nifrajs/web": patch
---

On Windows, the development guards and the build name files with `/` relative to the app, a Vite dev refusal shows its reason instead of a generic transform error, a pre-bundled dependency is judged by the source Vite built it from, and browser source maps resolve modules Vite serves from outside the root (`/@fs/`). A message about an emitted file names it relative to the app, and a `routes/` directory created after the dev server started holds routes whatever spelling the app root was given in.
