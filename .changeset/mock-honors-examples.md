---
"@nifrajs/mock": minor
---

`generateMockValue` now honors authored `examples` and `default` before synthesizing (`const` still wins). This is the escalation layer for constraints a generator cannot invert: an arbitrary `pattern` regex, or a refinement that never reaches the JSON Schema at all (zod `.refine()`). Annotate once, next to the constraint - zod: `.meta({ examples: ["AB-1234"] })`; TypeBox/raw JSON Schema: the `examples` or `default` keyword - and every consumer uses it: the adversarial laboratory's witness synthesis (closing NO_WITNESS on uninvertible regex leaves and INVALID_WITNESS on refinements, since the witness is still proven against the real validator) and the mock server's responses. The first example is used, deterministically; without an example, behavior is unchanged (uninvertible patterns still fail closed).
