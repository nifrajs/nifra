---
"@nifrajs/cli": patch
---

`nifra check`'s fail-open gate rule (NF-S001) now reads a gate's catch block as code. Before, the words "throw" or "return false" anywhere in the block counted as failing closed, even inside a comment, a string, or a callback the catch never runs. The rule also recognises more gate names:

- `authenticate…`, `authorise…` and names ending in `Guard`.
- `ensure`, `verify`, `check` or `validate` followed by what a gate decides on, such as `verifyToken`, `ensureLoggedIn` or `checkPermission`. `ensureDir` and `checkHealth` are still not treated as gates.
