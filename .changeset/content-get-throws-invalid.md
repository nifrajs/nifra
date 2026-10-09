---
"@nifrajs/content": patch
---

`collection.get(slug)` now throws for an entry whose frontmatter fails to parse or validate, as `all()` does, and returns `null` only when no file exists for the slug. A broken entry used to look like a missing one, so a page answered 404 instead of surfacing the error.
