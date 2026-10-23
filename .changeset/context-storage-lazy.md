---
"@nifrajs/middleware": patch
---

`@nifrajs/middleware/context-storage` does no work when imported, so a bundle that imports it without calling it leaves it out. `getContext()` outside a request now also says that a partially prerendered shell is built outside every request.
