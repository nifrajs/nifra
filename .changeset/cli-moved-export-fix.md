---
"@nifrajs/cli": minor
---

`nifra check` reports an import of a name that moved to a package subpath under NF-C005, naming the module that exports it now, and `nifra fix --code NF-C005` rewrites the import - re-exports and aliases included. It covers `solidBunPlugin` (`@nifrajs/web-solid/plugin`) and `svelteBunPlugin` (`@nifrajs/web-svelte/plugin`).
