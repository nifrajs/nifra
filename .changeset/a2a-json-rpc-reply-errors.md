---
"@nifrajs/a2a": minor
---

Every reply on the A2A JSON-RPC route is now a JSON-RPC response. A result larger than `maxOutputBytes`, or one that cannot be serialized, answers with HTTP 200 and a `-32603` error (`output_limit` or `response_serialization_failed`) for the request's `id`, where it was an HTTP 500 with a bare `{ "error": ... }` body. A request whose `ports` or state store throws keeps its `id` in the `-32603 internal_error` reply instead of `null`.
