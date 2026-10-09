---
"@nifrajs/coding-agent": patch
---

The evidence stores hash each record synchronously instead of through `crypto.subtle`, which sent every append to a worker thread and back: 10,000 appends take about 21 ms instead of 141 ms (more on a loaded machine). Digests are unchanged.
