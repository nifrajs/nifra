---
"@nifrajs/mock": minor
"@nifrajs/testing": minor
---

The adversarial laboratory and the mock server now recognize zod automatically - no wiring. Every Standard Schema carries a `"~standard".vendor` tag, so when a body/query/response validator says "zod" and zod (4+) is installed, the new `autoReflectJsonSchema` default (exported from `@nifrajs/mock`) converts it via `z.toJSONSchema` exactly as the `@nifrajs/testing/zod` bridge does. Out of the box, zod routes now get synthesized witnesses and constraint-driven mutations in `runAdversarialContract`/`assertAdversarialContract` instead of NO_WITNESS, and `createMockServer` returns real data instead of `{}`. zod stays an optional peer, loaded lazily and probed once; a project without zod (or with a schema zod cannot convert) keeps today's opaque behavior. An explicit `reflectJsonSchema` hook always overrides the default - pass `() => undefined` to force everything opaque.
