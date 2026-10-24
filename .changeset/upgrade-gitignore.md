---
"@nifrajs/cli": patch
---

`nifra upgrade` skips gitignored files, the way `nifra check` already did, so a backup copy or a
generated app inside the project is neither edited nor reported. NF-C007's fix text now names
`bytes()` from `@nifrajs/core/binary` for a file or other binary body and `raw<T>()` for a
hand-built JSON `Response`.
