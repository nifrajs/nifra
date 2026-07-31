---
"@nifrajs/cli": patch
---

`nifra check`, `nifra assure` and `nifra levels` are three views of one project verification.

All three read the same reflected project: the typed-contract scan, the route-assurance evaluation,
and the static capability provenance. Each had grown its own orchestration over those pieces, so which
command ran which policy was something a caller had to keep in their head, and `nifra levels` paid for
it twice. Its L0 rung runs the whole check, and then L1 and L2 re-derived the route-assurance and
capability-provenance evidence that same check had just produced. On a project with a capabilities
policy the provenance walk is the expensive part, and it ran on every `levels` invocation once for the
check and again for the ladder.

They now derive from a single verification pass. Each command renders its own slice of it: `assure`
still never triggers the typecheck it has no use for, and `levels` climbs the ladder from evidence
gathered once rather than a second time per rung. The output of all three is unchanged down to the
byte, and a golden test per command and per mode holds that line so it stays that way.
