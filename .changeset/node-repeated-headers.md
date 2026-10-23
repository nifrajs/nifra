---
"@nifrajs/node": patch
---

A header sent twice reaches the app as every value joined with ", ", as Fetch's `Headers` gives it on
Bun, Deno and Workers. Node kept only the first Content-Type, Authorization or User-Agent, so two
Content-Type fields were a JSON body on `@nifrajs/node` and a 415 everywhere else.

A request with two Host fields answers 400, as on Deno and as RFC 9112 requires: joined, the app would
read both authorities from Host while the request was routed on the first.
