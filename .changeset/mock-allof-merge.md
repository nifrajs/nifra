---
"@nifrajs/mock": patch
---

`generateMockValue` now builds an `allOf` value from one merged schema: bounds tighten, `required` and `properties` combine (a property in several branches gets all of their constraints), and `type` and `enum` intersect. It used to generate each branch separately and merge the objects, so a property constrained in two branches kept only one branch's constraint (`minimum: 18` plus `maximum: 30` could yield `-60`). Branches that disagree on any other keyword now fail with `UnsupportedMockSchemaError`.
