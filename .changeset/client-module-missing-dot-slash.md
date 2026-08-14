---
"@nifrajs/cli": patch
---

App load now rejects a `clientModule` that has no `./` prefix but names a real local file. Such a
specifier is read as a bare package specifier and resolved against `node_modules`, not the project - so
`src/client.tsx` (a forgotten `./`) is ignored, no package is found, and the bundle fails deep in the
build with an opaque "cannot resolve". Load catches it up front and reports the one-character fix
(`./src/client.tsx`), so `nifra dev` and `nifra build` resolve the same local entry. Scoped (`@…`),
absolute, and genuine bare-package specifiers are unaffected.
