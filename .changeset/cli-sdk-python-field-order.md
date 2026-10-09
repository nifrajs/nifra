---
"@nifrajs/cli": patch
---

`nifra sdk --language python` writes a model's required fields before its optional ones. A model that listed an optional property before a required one produced a dataclass that Python refused to import (`non-default argument follows default argument`). Each group keeps the schema's order.
