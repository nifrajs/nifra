---
"@nifrajs/core": patch
---

`diffRouteSnapshots`, and the `nifra diff`, contract proof, and manifest diffs built on it, compare the object schema around a section's fields as well as the fields. A change to `additionalProperties`, to the `$defs` a field's `$ref` points into, or to a required name that no field declares is reported as breaking, so a diff against an existing baseline may list changes it did not list before.
