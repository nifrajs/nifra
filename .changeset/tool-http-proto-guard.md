---
"@nifrajs/core": patch
---

`createToolHttpHandler` applies the prototype-poisoning policy to its JSON request body. A body
carrying an own `__proto__` key, or an own `constructor` key whose value holds an own `prototype`,
is rejected with the same `input_invalid` tool result as malformed JSON, so probing cannot
distinguish a blocked payload from a syntax error. The handler is standalone (never mounted on a
server), so it carries its own `protoPoisoning` option - `"reject"` (default), `"strip"`, or
`"ignore"` - mirroring the server option. The body remains read unbounded; cap request size at the
platform or server mounting the handler.
