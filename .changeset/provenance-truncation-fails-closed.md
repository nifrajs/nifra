---
"@nifrajs/cli": minor
"@nifrajs/core": minor
---

Capability provenance says when it could not finish, instead of reporting a clean project.

The reachability walk stops at a module count and an import depth so a pathological graph cannot hang
the check. Hitting either limit used to end the walk quietly, and the route came back covered - a
passing report whose subject was partly unexamined, which is the shape of failure this whole gate
exists to prevent.

Both limits now produce a `provenance-truncated` finding naming the route and the chain that reached
it, the check fails, and the lockfile refuses to record a snapshot taken from a truncated walk.
