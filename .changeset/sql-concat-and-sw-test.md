---
"@nifrajs/cli": minor
"@nifrajs/web": patch
---

The interpolated-SQL rule catches string concatenation, the oldest injection shape.

```ts
db.query("SELECT * FROM users WHERE id = " + req.params.id)   // now fails the check
```

The rule inspected template literals only: a quoted string was skipped before the SQL-keyword test ever
ran. So a codebase predating template literals - or an LLM emitting older-style JS - got a clean
`nifra check` on textbook-injectable SQL, and `nifra check` reporting clean is a security claim that
feeds the assurance ladder.

The same keyword requirement applies, so `cache.query("user:" + id)` stays quiet, and a statement built
into a variable elsewhere still says nothing at the call site.

Also fixes the service-worker test suite, whose offline case never reached the code it claimed to test:
the stub was assigned to `globalThis.fetch` after the worker had already captured `fetch` as a
parameter, so the assertion was satisfied by a real network failure. A worker mutated to serve the
offline page to every visitor passed all 19 tests; it now fails, and an online navigation is covered.
