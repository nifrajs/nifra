---
"create-nifra": patch
---

A scaffold's feature flags declare what they contribute instead of racing to write it.

`--db`, `--auth` and `--deploy` each reached into the parsed `package.json` and spread themselves over
it, in an order fixed by the line their handler sat on. Last writer won, silently. A preset that
shadowed the scaffold's own `check` script would have removed the assurance gate from every project
scaffolded with it, and nothing anywhere would have reported that.

No shipped preset does that - all six were checked - which is the moment to add the rail rather than
after someone adds the seventh. Each flag now states its contribution, and an undeclared collision is
an error naming both sides. Replacing a key stays possible where it is the point: `--deploy` repoints
the canonical `build` and `deploy` aliases at the chosen target, and says so.
