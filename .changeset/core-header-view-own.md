---
"@nifrajs/core": patch
---

On the Node direct lane, the header view a response hook receives answers only for real headers: `has("constructor")` is `false` and `get("constructor")` is `null`, as on a Web `Headers`, where it previously reported an inherited property or threw.
