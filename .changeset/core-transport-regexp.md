---
"@nifrajs/core": minor
---

A request body decoded by `transportCodecs()`, or a WebSocket frame decoded by a route's `transport`, may no longer hold a `RegExp` unless the lane opts in with `acceptRegExp: true`. A pattern from the client is code: one with catastrophic backtracking stalls the event loop the moment anything runs it. A refused body answers the same 400 as an undecodable one, and a refused frame goes to `onInvalidMessage`. Values the server sends are unaffected.
