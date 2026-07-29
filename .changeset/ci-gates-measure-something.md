---
"@nifrajs/cli": patch
---

Two CI gates that could report success having measured nothing.

`@nifrajs/events` shipped with 17 passing tests CI had never executed. The two run scripts list their
30-odd test directories by hand and nobody added the new one, so the package published untested and the
coverage ratchet was blind to it. The dead suite was the fail-closed half of a durable event boundary.
A completeness check now asserts every package with test files appears in both scripts, with an
explicit, reasoned opt-out list.

`check:size` dropped any row that failed to build - logging to stderr, returning null - and then
compared budgets only against rows that survived. Rename a `@nifrajs/core/*` subpath and its row
vanishes with its budget, every remaining row passes, and the gate exits 0. It now reconciles measured
rows against declared rows, and the budget table against the feature matrix, before comparing anything.
