---
"@nifrajs/client": minor
---

A DELETE route that declares a body schema can be called with its body: `api.items.delete({ body: { ids } })` sends it as JSON, and the types require it there. A DELETE without a body schema keeps its bodyless options.
