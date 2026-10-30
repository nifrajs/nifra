---
"@nifrajs/cli": patch
---

NF-C057 names the same page on every machine when two pages are equally close to a mistyped link: the pages are compared in code-unit order, not in the order the file system lists them.
