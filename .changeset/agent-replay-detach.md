---
"@nifrajs/agent": minor
"@nifrajs/ag-ui": patch
---

A replay connection that closes detaches its live view from the turn: `mountAgent` and `mountAgUI` return the view when the client cancels, and the memory evidence log stops sending evidence to a returned view. The logged run keeps recording for the next reconnect. `createMemoryAgentEvidenceLog({ maxSubscribers })` caps live views per running turn (default 64); one more ends the oldest. `createAgentEvidenceStream({ onReturn })` reports when a consumer returns its stream.
