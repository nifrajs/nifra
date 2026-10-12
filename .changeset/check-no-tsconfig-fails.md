---
"@nifrajs/cli": patch
---

`nifra check` (and `nifra_check`) now fails when the directory has TypeScript sources but no `tsconfig.json`, with a `typecheck` error that says the gate did not run and how to add one, as it already did for a `tsconfig.json` with no `typescript` install. Before, the typecheck was reported as skipped and the check passed, so a project with type errors and no tsconfig got a green check. A project with only JavaScript (and declaration files) still skips the typecheck and passes.
