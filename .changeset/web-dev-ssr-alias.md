---
"@nifrajs/web": patch
---

On the Bun pipeline's dev server, an edit to a module imported through a path alias (`@/components/Button`, `~/lib/x`, `#internal/x`) is picked up by server rendering. Before, only relative imports were re-evaluated, so SSR kept rendering the aliased module as it was when the server started. An alias shaped like a package name (`@app/x`, `src/x`) is still not recognized.
