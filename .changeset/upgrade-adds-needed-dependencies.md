---
"@nifrajs/cli": patch
---

`nifra upgrade` can add a package that an imported entry needs: when a source file, a Svelte or Vue
component included, imports an entry that names it, and the nearest package.json lists it in no
dependency field, the upgrade adds it at the target version beside the package the entry belongs to,
in each field that package is in. The plan lists each addition with the file that needed it. The
5.7.0 recipe uses it for `@nifrajs/authjs`, `@nifrajs/image`, `@nifrajs/i18n` and `@nifrajs/schema`,
which apps reached through an adapter until now.
