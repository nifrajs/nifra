---
"@nifrajs/client": minor
"@nifrajs/cli": minor
---

Typed collision escape for reserved-named route segments. The client proxy resolves the seven HTTP verbs (any casing) plus `subscribe`, `ws`, `index`, and `then` before path segments, so a route like `POST /api/delete` cannot be reached by dot access - `api.delete` is the DELETE verb. The typed spelling is now a call on the parent node: `api.api("delete").post()` sends `POST /api/delete`. The call signature accepts exactly the colliding segment names under that node (it is not a general string path builder), coexists with param calls on the same node (an object is a param bag, a string literal the segment), and covers all eleven reserved names including `then`. Purely additive - no runtime change, no existing call site affected.

`NF-C018` accordingly downgrades from error to warning and its message now spells out the escape call for the flagged route, alongside the existing rename and `nifra-expect reserved-segment` options.
