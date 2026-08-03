---
"@nifrajs/cli": patch
---

`nifra doctor` now scans `*.test.ts`/`*.spec.ts` files for undeclared imports. Tests are part of the typechecked surface, so a package imported only by a test and declared nowhere still breaks a clean `bun install` build - doctor previously shared `nifra check`'s test exclusion and missed it. `nifra check`'s own scans still skip tests, which legitimately drive `fetch` and call routes directly.
