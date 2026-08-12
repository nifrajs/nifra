---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/deno": patch
"@nifrajs/workers": patch
---

A `.ws()` route's `maxPayloadBytes` is now enforced on every runtime, not only the ones whose socket
implementation happened to police it. The declared cap travels with the upgrade outcome, so the Node
bridge hands it to `ws` as `maxPayload`, and the Deno and Workers/`attachWebSocket` message paths
measure the frame and close with `1009 message too large` instead of delivering it. A route that
declares no cap is untouched and pays nothing: sizing a text frame costs a UTF-8 encode, so the
measurement only runs where a cap exists.
