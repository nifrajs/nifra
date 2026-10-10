---
"@nifrajs/mock": minor
"@nifrajs/testing": patch
---

The default `reflectJsonSchema` hook reads a schema's own Standard JSON Schema converter (`~standard.jsonSchema.input`, implemented by zod 4.2+ and other libraries) before it looks for zod on disk. The adversarial laboratory and the mock server now inspect such a schema wherever the test runs from, including a monorepo root whose zod is installed only in one app, and a validator other than zod that implements the converter gets witnesses and mock data too. An older zod 4 is still converted with `z.toJSONSchema`. When a converter throws, the gap names it.
