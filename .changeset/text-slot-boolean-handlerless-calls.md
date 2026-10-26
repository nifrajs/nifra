---
"@nifrajs/cli": patch
---

NF-C055 no longer reads the options of a call with a path and no handler as a route's, such as `config.get("flags", { query: z.object({ on: z.coerce.boolean() }) })`.
