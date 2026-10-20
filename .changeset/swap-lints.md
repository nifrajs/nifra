---
"@nifrajs/cli": minor
---

`nifra check` reads slot swap markup (`@nifrajs/web/islands/swap`), judging only literal values:

- NF-C049 (warning): `data-swap` on anything but `<a href>` or `<form>`, in JSX, or with a value other than `replace:<slot>` or `append:<slot>`.
- NF-C050 (warning): a `data-swap` names a slot that no `data-swap-slot` in the project declares.
- NF-C051 (warning): a `data-swap-slot` whose content is not its `slot()` call alone, a `slot()` placed outside its slot element, a second slot of one name in the same markup, or a malformed slot name.
- NF-C052 (warning): a `data-swap` URL goes to a page whose module, layouts and the local files they import render no `slot()` of that name.
- NF-C048 also flags a binding inside a `data-swap-slot` that belongs to an island outside it, and the island lints treat `enableSwap({ ... })` like `mountIslands({ ... })`.

`nifra cdn-check` also sends a swap-shaped request and fails when the CDN answers it from cache.
