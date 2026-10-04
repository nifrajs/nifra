---
"@nifrajs/core": patch
---

The effect ledger, `useCapability`, `executeCapability`, effect lifecycle events, and the durable effect journal take a token field (`target`, `effectId`, `digest`, a capability id, an error code) only when it is a string of the token's shape. A row, a number, `null`, or an array in one of those fields is refused instead of stored, and a durable store record that holds one is refused when it is read.
