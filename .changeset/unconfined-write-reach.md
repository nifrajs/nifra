---
"@nifrajs/core": minor
---

A safe-method route that can reach a domain write is reported once, with the fix it actually has.

It used to draw two findings giving opposite advice: `undeclared-capability-evidence` (declare what you
reach) and `safe-method-domain-write` (a safe method may not declare a domain write). Both are correct
and together they are a dead end - the route cannot declare its way out, because the declaration was
never the problem.

Reach is computed from the module that registers a route, so a read endpoint sitting beside a write
seam has write powers in scope. The new `unconfined-write-reach` finding says that, and says to move
the route or the effect. Still an error, and the report still fails; a GET that explicitly DECLARES a
domain write is unchanged, because that one really is an HTTP semantics mistake.
