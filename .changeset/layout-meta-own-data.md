---
"@nifrajs/web": major
"@nifrajs/cli": minor
"create-nifra": patch
---

A layout's `meta` receives its own loader data as `data`, the value its component renders, or `null` when the layout has no loader, and the page's data as `pageData`. A layout that loads the locale sets `<html lang>` from its data, and a client navigation keeps it, since the soft-navigation head resolves each layout's `meta` with the same data the server used. A page's `meta` is unchanged and also receives `pageData`. `resolveChainMeta` from `@nifrajs/web/client` resolves a route's `meta` chain this way. Generated route types add `Route.MetaArgs`, typed with the module's own loader data.

Upgrading: a layout `meta` that read the page's data as `data` reads `pageData` now. `nifra check` reports a layout with no loader whose `meta` reads `data` (NF-C040), and the 5.0.0 upgrade notes name the change.
