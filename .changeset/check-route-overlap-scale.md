---
"@nifrajs/cli": patch
---

`nifra check` no longer compares every pair of routes in a file for overlaps (NF-C024): only routes whose leading literal segments agree are compared, so a file with 2,000 routes under distinct prefixes is checked in milliseconds instead of seconds. The verification work graph de-duplicates edges and walks impact through an edge index, so building and querying it grow linearly with the number of routes.
