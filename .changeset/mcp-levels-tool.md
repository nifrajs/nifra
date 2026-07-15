---
"@nifrajs/cli": minor
---

Add the `nifra_levels` MCP tool, so an agent can read the verification ladder it was already able to
run from the CLI. It returns `{ achieved, levels[] }` across L0 typed contract, L1 route assurance,
L2 capability lockfile, L3 route trust manifest, and L4 contract invariants, with the reasons a level
does not hold. A project with no assurance config still answers, stopping at L0 rather than failing.
