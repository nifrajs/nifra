---
"@nifrajs/coding-agent": patch
---

The agent RPC server throttles only failed authorization attempts. A request carrying the right token is served during a backoff, so wrong guesses from another caller no longer block the real client.
