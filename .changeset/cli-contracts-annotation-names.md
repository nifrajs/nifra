---
"@nifrajs/cli": patch
---

The contracts lock digest covers schema properties named `title`, `description`, `default`, `example` or `examples`, and the instance data inside `enum` and `const`. Those annotation keywords on a schema itself still do not count as a contract change. A lock written by an earlier release reports each route with such a property as changed once; review it and run `nifra contracts snapshot`.
