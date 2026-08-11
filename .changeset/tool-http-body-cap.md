---
"@nifrajs/core": minor
---

`createToolHttpHandler` caps its JSON request body. The handler is standalone - it is not mounted on
a server and so inherited no `maxBytes` - and used to read the body unbounded, documenting the limit
as the mounting platform's job. It now defaults to 1 MiB (`DEFAULT_TOOL_MAX_BYTES`), configurable
with `maxBytes`. An oversized body answers a flat `413` and a malformed `Content-Length` a flat
`400`, both before the parse, so nothing oversized is ever materialized as a JS value.

Running uncapped stays possible but must be declared: `maxBytes: "unlimited"` requires a non-empty
`maxBytesReason`, and a reason without `"unlimited"`, or a cap that is not a non-negative safe
integer, throws when the handler is created rather than at request time.

**Breaking for bodies over 1 MiB.** A tool whose inputs legitimately exceed that must set `maxBytes`
to its real ceiling, or opt out with a reason.
