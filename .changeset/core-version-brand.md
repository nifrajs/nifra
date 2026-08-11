---
"@nifrajs/core": minor
---

The server type records which copy of `@nifrajs/core` declared it. `Server` carries a type-only
`__nifraCoreVersion` brand holding the package's feature version (`major.minor`), exported as
`NifraFeatureVersion`, so a hover over `typeof app` - or an assertion in a test - says which core an
app is built against. Nothing is emitted at runtime and no field is allocated per server.

Two copies of core in one build stay a compile error, as before; `nifra doctor` is what names the
two install paths.
