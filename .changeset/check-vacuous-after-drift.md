---
"@nifrajs/cli": patch
---

`nifra check` (and MCP `nifra_check`) reports contract drift when every route schema the contract lock recorded has been removed. It used to see that no route declares a schema now, answer with only the "trust manifest is vacuous" note, and pass while `nifra contracts check` failed. The note now appears only when the lock and the routes agree.
