---
"@nifrajs/cli": patch
---

`nifra verify --release` runs the library test suites once. Its `coverage` gate already fails on any failing test, so the release plan no longer has a separate `tests` gate. A new `rest-tests` gate runs `bun run test:rest`, the suites the coverage run leaves out. The default plan (`nifra verify`) still runs `tests`.
