---
"@nifrajs/cli": patch
---

NF-C031 reads the schemas an output schema names inside it (`t.object({ user: userSchema })`, `t.array(member)`) and schemas imported from another project file, each where it is declared. A sensitive field in such a schema passed `nifra check` and failed only when the route loaded. A schema under `t.declassified(...)` is not followed, and a schema shared by several routes is reported once, at its declaration.
