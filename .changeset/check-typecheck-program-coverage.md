---
"@nifrajs/cli": patch
---

feat(check): `nifra check` fails the typecheck when TypeScript files under `routes/`, `frontend/`, `backend/` or `shared/` sit outside the tsc program, so a stale tsconfig `include` can no longer pass a typecheck that never read them. One finding per folder lists the files. A file the tsconfig's `exclude` names (inherited through `extends`) is out on purpose and not reported; others kept out on purpose go under `"typecheck": { "ignore": [...] }` in `nifra.check.json`.
