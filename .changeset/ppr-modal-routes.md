---
"@nifrajs/web": minor
---

A partially prerendered route may declare an intercepting boundary (a modal route) beside its holes. `partialPrerendering()` used to refuse it at the first request; now the shell carries the boundary unresolved, and a client navigation to its URL opens the target over the page with the page and its filled holes still mounted. The boundary is not a hole and does not count toward `maxHolesPerRoute`.
