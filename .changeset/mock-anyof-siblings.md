---
"@nifrajs/mock": patch
---

A mocked `anyOf` value now satisfies the keywords beside it. A schema such as `{ type: "string", maxLength: 1, anyOf: [...] }` previously generated from one alternative alone, so the mock could return a value the schema rejects; each alternative is now merged with its siblings, an alternative they contradict is skipped, and a schema with no satisfiable alternative throws `UnsupportedMockSchemaError`.
