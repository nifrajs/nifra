---
"@nifrajs/i18n": patch
---

`localizePathname` and `unlocalizePathname` drop tabs and newlines from a path before splitting it, as URL parsing does, so a path such as `/<tab>/evil.example` can no longer come out as one a browser follows to another host.
