---
"@nifrajs/core": minor
"@nifrajs/cli": minor
---

`invariants.setup` in `nifra.assurance.ts` may return `witnesses` and `prepareRequest` beside `executor` and `teardown`, so a success witness can name what exists only once the throwaway target is up: a real slug, a row id, a signed-in session. Its witnesses are merged over the static `invariants.witnesses`, a `"METHOD /path"` in both taking the setup's, and validated the same way, so a malformed one fails with the same `route assurance:` error. Its `prepareRequest` replaces the static one. `setup` now runs once per L4 run before the run generates its first case, still never on import, and `teardown` still runs after a failure, a malformed setup result included. `nifra levels` lists the witnesses that came from setup under L4, and the `nifra_levels` result carries them as `setupWitnesses`. `applyInvariantSetup` from `@nifrajs/core/assurance` merges and validates a setup result for a harness that runs L4 itself.
