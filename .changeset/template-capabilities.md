---
"create-nifra": minor
---

Every template declares its capabilities, so a scaffolded app can reach L2 of `nifra levels`.

`nifra.assurance.ts` now carries a `capabilities` block defining `db.read` and `db.write`, and the
`authenticated-write` rule matches `{ access: "write", zone: "domain" }` instead of naming `db.write`.
Any write token added later - `payments.charge`, `orders.write` - is covered by that rule the day it is
declared, without editing the policy.

L2 was previously unreachable from a scaffold: the level requires a capability policy, no template
shipped one, and writing one from scratch was the only way up. It is now one `nifra capabilities
snapshot` away.

`provenance.imports` ships empty with a worked example and the one caveat that matters, which is that a
route's reach is computed from the module that REGISTERS it, following its imports. A module that
registers routes and imports a database gives every route in it database reach, and a GET route is
refused a domain write outright - so turning the import firewall on wants a root that is pure
composition, with effects owned by the modules underneath.

The `isr` template gains a `nifra.assurance.ts`; it had none, which capped it at L0.
