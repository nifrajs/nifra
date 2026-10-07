---
"@nifrajs/cli": patch
---

feat(cli): `nifra migrate layout` updates the tooling around moved code. It rewrites `mock.module()`, `vi.mock()` and `jest.mock()` paths with the imports, adds the zone folders moved TypeScript lands in to tsconfig `include` (editing only that array, comments kept), adds `.nifra/` to `.gitignore` when nothing ignores it, and reports Tailwind `content` globs that no longer match moved files. Data files (JSON, YAML, CSV and similar) are reported instead of moved, since other tools may read them by path, and folders listed under `"nifra": { "zones" }` in package.json stay where they are.
