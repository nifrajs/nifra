---
"create-nifra": patch
---

The next steps printed after `--db` now match the scripts each preset writes: Prisma and Kysely apps are told to run `bun run db:migrate` only, since they have no `db:generate` step to run first.
