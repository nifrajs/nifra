---
"@nifrajs/cli": patch
---

`nifra verify --release` runs the leak matrix (`bun run check:leak-matrix`): every way server code or a
credential can reach a browser, against both bundlers, both dev servers, the server build, each
framework's route syntax and each deploy target's output.
