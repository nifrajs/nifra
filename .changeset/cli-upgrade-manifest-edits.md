---
"@nifrajs/cli": patch
---

`nifra upgrade`:

- Removing a dependency whose successor is already declared keeps `package.json` valid when the removed entry is the last one in its block. An edit that would leave a manifest unparseable is not written.
- `dist/`, `build/` and `coverage/` directories at the workspace root are skipped like nested ones, so build output and coverage reports are no longer rewritten.
