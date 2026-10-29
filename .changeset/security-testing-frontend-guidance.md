---
"@nifrajs/cli": patch
---

Expand `nifra frontend` and `nifra_frontend` with version-scoped, source-linked React, Preact, Solid, Vue, and Svelte gotchas. `nifra frontend --json` prints stable structured entries, and `nifra_frontend` now returns them as `structuredContent` beside the rendered text. `nifra frontend` now rejects unknown flags instead of ignoring them, and symptom text is capped at 256 characters. Add executable security invariant coverage and nightly mutation targets for core security boundaries.
