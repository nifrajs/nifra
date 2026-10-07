---
"@nifrajs/image": patch
---

A remote image source refused before its body is read (an upstream error status or a declared size over `maxSourceBytes`) now has its body cancelled and its fetch aborted, so the upstream exchange ends with the request instead of staying open.
