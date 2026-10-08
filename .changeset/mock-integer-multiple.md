---
"@nifrajs/mock": patch
---

An `integer` schema with a fractional `multipleOf` generates integer multiples of it, so `multipleOf: 1.5` yields 3, 6 and so on. A `multipleOf` that is not a plain decimal, such as `1e-7`, on an integer schema throws `UnsupportedMockSchemaError`.
