---
"@nifrajs/cli": patch
---

The release verification plan runs `test:postgres`: the live Postgres suites of `@nifrajs/mcp-db`
and `nifra db`, against the throwaway server `NIFRA_TEST_POSTGRES_URL` names. Without the variable
they skip.
