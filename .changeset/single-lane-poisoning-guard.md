---
"@nifrajs/core": patch
---

Collapse the JSON body lane onto one guarded path and make the poisoning walk cheaper.

Framed JSON bodies now take the runtime's fused `json()` at every size instead of splitting at 1KB,
and the guard walks the parsed value directly - the raw-text substring pre-scan is gone, since it
cost more than the walk it was meant to avoid. The walk itself only stacks object nodes, so scalar
keys and scalar array elements no longer make the round trip through it.

No behaviour change: the same payloads are accepted, and the same poisoning shapes - including ones
spelled with `\uXXXX` escapes - are still rejected or stripped under `protoPoisoning`.
