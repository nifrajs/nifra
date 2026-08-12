---
"@nifrajs/mcp": patch
---

`handleRpc` rejects a `tools/call` whose request id is already in flight, with
`-32600 duplicate request id is already in progress`, instead of starting a second call under the same
id. Registering the second call overwrote the first's `AbortController`, so `notifications/cancelled`
for that id then cancelled only the newer call and left the earlier one running with nothing able to
stop it. JSON-RPC requires an id to be unique among in-flight requests, so no conforming client is
affected.
