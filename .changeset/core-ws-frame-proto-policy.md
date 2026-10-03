---
"@nifrajs/core": patch
---

A WebSocket route with a `messageSchema` parses each frame under the app's `protoPoisoning` policy, as a JSON body is parsed. Under the default `"reject"`, a frame with a `__proto__` key goes to `onInvalidMessage` as invalid JSON. `wrapWebSocketMessageValidation` takes the policy as an optional second argument.
