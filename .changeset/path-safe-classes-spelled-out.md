---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

No behavior change: the character classes that decide which characters a parsed request path keeps as written now list each character instead of using the ranges `#-;` and `?-]`. They match the same set.
