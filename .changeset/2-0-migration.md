---
"@nifrajs/cli": minor
---

Ship the executable 2.0 migration path and consolidated upgrade documentation.

- `nifra upgrade 2.0.0` updates the fixed Nifra package group while preserving range style, moves
  the removed `@nifrajs/budget` dependency to `@nifrajs/core`, rewrites its source imports to
  `@nifrajs/core/budget`, and prints the structural cutover notes it cannot safely infer.
- Pin rules now treat bare package names as exact matches, so upgrading `nifra` cannot rewrite an
  unrelated dependency such as `nifra-plugin`.
- The 1.x → 2.0 guide covers opt-in runtime plugins, lean subpath imports, backend mounts, typed
  client failures, web/protocol changes, release gates, and `nifra.check.json` external mounts for
  Better Auth-style route owners.
- External-mount matching rejects percent-encoded parent traversal as well as literal `..`, so the
  lint exception cannot hide a fetch that URL normalization moves outside its declared prefix.
