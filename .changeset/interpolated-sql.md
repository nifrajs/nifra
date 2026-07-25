---
"@nifrajs/cli": minor
---

`nifra check` fails on SQL built by interpolating a value into the statement text.

```ts
db.query(`SELECT * FROM notes WHERE id = ${id}`)   // fails the check
db.query("SELECT * FROM notes WHERE id = ?").get(id)  // bound
db.execute(sql`SELECT * FROM notes WHERE id = ${id}`) // bound by the tag
```

The interpolated value becomes statement rather than parameter, so anything the caller controls can end
the literal and continue as SQL.

Two things it deliberately stays quiet about, because flagging a safe idiom is how a rule gets ignored:
a TAGGED template (`` sql`… ${id} …` `` in postgres.js, drizzle and kysely binds its substitutions -
that IS the parameterised form), and any literal without a substitution. A SQL keyword is required in
the literal too, so `cache.query(`user:${id}`)` is left alone; the named escape hatches
(`$queryRawUnsafe`, `sql.unsafe`) are flagged on the call alone, since taking a statement as text is
their entire purpose.
