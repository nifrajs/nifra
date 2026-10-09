---
"@nifrajs/mcp-db": patch
"@nifrajs/cli": patch
---

`postgresRoleSql` and `nifra db-role` grant the role `SELECT` on each allowed schema only. On Postgres 14 and later, with nothing excluded, the role used to get `pg_read_all_data`, which reads every schema in the database whatever `schemas` named.
