---
"@nifrajs/schema": minor
---

`toOpenAPI(app, { openapiVersion: "3.2.0" })` describes a QUERY route as the path item's `query` operation, with its request body. A 3.1 document has no field for it and leaves the route out, as before. `importOpenAPI()` accepts OpenAPI 3.2 documents, and reads a `query` operation only from one.
