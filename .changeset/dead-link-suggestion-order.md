---
"@nifrajs/cli": patch
---

NF-C057 and NF-C058 judge a link with a `${...}` in it against the pages it can reach, so `` href={`/${slug}`} `` resolves to the dynamic page `/:slug` and no longer to a page that happens to be named `x`. When two pages are equally close to a mistyped link, the diagnostic names the same one on every machine: the pages are compared in code-unit order, not in the order the file system lists them.
