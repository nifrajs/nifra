---
"@nifrajs/core": patch
"@nifrajs/web": patch
---

fix(core, web): JSON request bodies are matched by media type

A body is parsed as JSON when its `Content-Type` media type is `application/json` or an
`application/*+json` type. A header that only mentions `application/json` in a parameter, such as
`text/plain; x=application/json`, is no longer parsed as JSON; browsers send that type cross-origin
without a preflight. Server functions apply the same comparison and answer such requests with 415.
