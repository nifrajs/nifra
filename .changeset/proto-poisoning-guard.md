---
"@nifrajs/core": minor
---

JSON bodies are now guarded against prototype poisoning. A payload carrying an own `__proto__`
key, or a `constructor` whose value carries a `prototype`, is rejected with the same flat `400`
as malformed JSON - before validation and before the handler. The new `protoPoisoning` server
option selects the policy: `"reject"` (default), `"strip"` (delete the keys in place and
continue), or `"ignore"` (opt out). The check covers the schema body lane, `c.boundedJson`, the
streaming no-length path, and `\u`-escaped spellings of the poisoned keys; the transport-codec
lane enforces the same policy on its own decoder via a matching `protoPoisoning` plugin option.
The common clean payload keeps the runtime's native fast path - the guard is a single iterative
pass over the parsed value, allocation-free, and benchmarks within noise of the unguarded
baseline.
