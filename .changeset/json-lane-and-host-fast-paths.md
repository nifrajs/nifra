---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

Cut per-request overhead on the JSON body lane and the Node adapter.

The bounded JSON reader now returns the body read's own promise instead of running as an async
function, so a framed JSON POST pays one microtask hop rather than several. The prototype-poisoning
walk checks the suspect keys during the single enumeration it already performs instead of probing
each node twice. The Node adapter memoizes Host-authority normalization, which repeats for every
request of a deployment.

No behaviour change: the same bodies are accepted, the same poisoning shapes are rejected or
stripped, and the same Host values normalize to the same authority.
