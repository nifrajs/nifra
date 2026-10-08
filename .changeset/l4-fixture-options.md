---
"@nifrajs/core": minor
"@nifrajs/cli": minor
"@nifrajs/testing": patch
---

`invariants` in `nifra.assurance.ts` accepts the L4 runner's fixture options - `witnesses`, `prepareRequest`, `isRejected`, `include` and `maxMutationsPerInput` - and `nifra levels` and the `nifra_levels` MCP tool pass them to every L4 run. `invariants.setup` provisions a throwaway target only when L4 runs: it is called once, before the first L4 request and never when the config is imported, and the `teardown` it returns runs after the run, a failing one included. A config needs an `executor`, a `setup`, or both. The contract witness and case-context types now live in `@nifrajs/core/assurance`; `@nifrajs/testing` re-exports them unchanged.
