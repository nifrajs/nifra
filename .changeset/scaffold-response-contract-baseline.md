---
"create-nifra": patch
---

A new app's `nifra.assurance.ts` now carries a `response-contract` baseline: every route that declares a `response` schema must enforce it, matched with `hasResponse: true`. The backend already installs `responseContract("enforce")`, so a fresh app passes. A route the contract does not cover now fails `nifra assure` and level L1 instead of sending fields its schema never declared.
