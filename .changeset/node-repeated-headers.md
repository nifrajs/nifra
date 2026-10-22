---
"@nifrajs/node": patch
---

A header sent twice reaches the app as every value joined with ", ", as Fetch's `Headers` gives it on
Bun, Deno and Workers. Node kept only the first Content-Type, Authorization or User-Agent, so two
Content-Type fields were a JSON body on `@nifrajs/node` and a 415 everywhere else.
