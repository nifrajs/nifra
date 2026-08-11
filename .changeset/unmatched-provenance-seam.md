---
"@nifrajs/core": minor
"@nifrajs/cli": minor
---

A capability provenance rule that matches nothing is now a finding. Seam specifiers in
`provenance.imports` and `provenance.routeModules` are compared with the text the code imports, so a
rule written as `src/db` when the module is imported as `./src/db.ts` silently governed zero
modules - the policy looked satisfied because nothing was ever attributed to it. `nifra check` now
reports `unmatched-provenance-seam` for every declared seam no scanned source matched, with the
nearest specifiers that were actually seen ("did you mean ...?") and a fix that points at rewriting
the rule to match the import, or deleting it.

`forbiddenImports` is deliberately excluded: zero matches there is the success state.

A rule that is genuinely absent in some projects sharing one policy can opt out with
`optional: true`, which suppresses the finding for that seam only.
