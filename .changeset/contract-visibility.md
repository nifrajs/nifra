---
"@nifrajs/cli": minor
---

`nifra check` reports contract operations the source implements but `backend/app.ts` does not serve (NF-C039, a warning). It finds each `implement(contract, ...)` call from `@nifrajs/core/contract` in the checked package (a nested package with its own package.json is left to its own check) (also through a project module that re-exports it), reads the contract's `defineContract({...})` in the same file or in a module imported through a relative path or an alias, and compares each operation's method and path with the routes the backend serves, a group or mount prefix included. The served routes come from the backend the contract-lock check loads, so the comparison runs when `contracts.lock.json` exists. With no `backend/app.ts`, one finding counts the implemented operations no gate can see. An operation whose method or path is not a string literal, or a contract the scan cannot read, is reported instead of skipped.
