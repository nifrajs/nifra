---
"@nifrajs/cli": minor
---

Route-table lints in `nifra check`: `NF-C018` (error) flags routes whose static path segments spell a reserved typed-client proxy key (get/post/put/patch/delete/head/options in any casing, plus `subscribe`, `ws`, `index`, `then`) - such routes are unreachable through the typed client; opt out for an intentionally non-typed-client route with `// nifra-expect reserved-segment` above the registration. `NF-C019` (error) flags the same method+path registered twice in one file, where which registration serves is undefined.
