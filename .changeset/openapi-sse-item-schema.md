---
"@nifrajs/schema": minor
"@nifrajs/middleware": minor
---

A typed SSE route (`app.sse()`) is now in the OpenAPI document. Before, it was a bare `200` with no content, so a client generator for another language had nothing to build the event type from. Its `200` answers `text/event-stream`, and its event schema becomes a named component (`<operationId>Event`, or one named after the path, deduplicated) so a generator emits a type for it. `toOpenAPI(app, { openapiVersion: "3.2.0" })` (and `openapi({ openapiVersion })`) declares OpenAPI 3.2 and describes each event with the standard `itemSchema`: a `data` string whose `contentSchema` is the event schema, plus `event`, `id`, and `retry`. The default stays 3.1, which has no field for stream items, so the same schema rides as `x-itemSchema` beside `schema: { type: "string" }`. A new docs page, /docs/control-api, shows a control API built this way: methods as routes, a resumable typed event stream, the typed client, and the document for other languages.
