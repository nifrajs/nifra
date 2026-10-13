---
"@nifrajs/cli": patch
---

Capability provenance (`nifra check` NF-C014, `nifra assure`) walks each installed package's import closure once per run, under its own 5000-module budget, instead of once per route inside the route's 500-module budget. A dependency with hundreds of data modules, such as a validation library's locale tables, no longer truncates every route that imports it, and its imports are still read: a forbidden effect import anywhere in the package is reported for each route that reaches it. A package past its own budget still fails closed, naming the package entry.
