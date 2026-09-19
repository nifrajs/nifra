---
"@nifrajs/jobs": minor
"@nifrajs/schema": minor
"@nifrajs/testing": minor
---

Add content-free dead-letter projections (`toDeadLetterView`, `toQueueHealth`) for queue triage without exposing payloads or error text; an OpenAPI 3.x inventory importer (`importOpenAPI`, `diffOpenApiInventory`) so export/import roundtrips prove the route table survives in CI; and a seeded hostile prediction/projection lab (`runPredictionLab`, `assertPredictionLab`) covering stale versions, expiry, prototype-grafting and non-atomic patches, commit conflicts, rollback paths, and WebMCP/MCP projection parity. `nifra check` also flags hand-rolled `EventSource`/`WebSocket` to the app's own API under the existing typed-client rule.
