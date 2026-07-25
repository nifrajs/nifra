---
"create-nifra": minor
---

`--db` scaffolds the data layer split by access, with a routes module that owns its own reach.

`db/read.ts` and `db/write.ts` sit in front of the connection, and `db/read-routes.ts` registers a
route importing only the read half. Merging it is one line.

The shape is not decoration. `nifra check` computes what a route can reach from the module that
registers it, following its imports; a route may not reach further than it declares, and a GET route
may not declare a domain write at all. A module holding both halves therefore has GET routes with no
legal declaration. Splitting reads from writes at the seam, and again at the routes, keeps every
route's declaration equal to its reach - which is what the `authenticated-write` rule needs in order to
mean anything.

The generated write example is commented rather than live, and says what happens when you uncomment
it: it fails `nifra assure` until authenticated, because the starter policy requires proof of who asked
before anything writes business state.
