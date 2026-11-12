---
"@nifrajs/web": patch
---

The build plan's client-graph guards, server-manifest drift checks, bundle size report and build targets are each their own module under `internal/`, and `build-plan.ts` re-exports them. The package's exports and behaviour are unchanged.
