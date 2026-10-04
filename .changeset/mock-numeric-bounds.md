---
"@nifrajs/mock": patch
---

Numeric mocks honor every bound a schema states:

- A schema with only `minimum` (or only `maximum`) picks a value within 100 of that bound instead of failing, so `{ type: "integer", minimum: 1900 }` mocks as 1900 to 2000.
- `exclusiveMinimum` and `exclusiveMaximum` are never reached, for integers, `multipleOf` steps and decimals alike.
- A decimal keeps two-place rounding only when the rounded value stays in range.
