---
"@nifrajs/testing": minor
"@nifrajs/mock": minor
---

Contract tooling works out of the box for validators that expose no JSON Schema (zod, valibot, arktype).

`runAdversarialContract` / `assertAdversarialContract` and `createMockServer` accept a `reflectJsonSchema` hook that derives an inspectable JSON Schema from an opaque Standard Schema validator. With it, zod routes get synthesized witnesses and constraint-driven mutations (min/max, length, pattern, enum, format) instead of a `NO_WITNESS` gap, and mocked responses carry real data instead of `{}`. A ready-made zod bridge ships as `@nifrajs/testing/zod` (`zodJsonSchema`); `zod` is an optional peer, so only projects that import that subpath need it installed. The adversarial report also gains an `advisories` list that flags when `validateResponses` is on but no route declares a `response` schema, making silently-zero response coverage visible.
