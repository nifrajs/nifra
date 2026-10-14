---
"@nifrajs/content": patch
---

`defineCollection` takes `watch: false` to list and parse its directory once and return that snapshot from every later `all()`. The default still lists the directory and stats every file per call, which costs 3.5 ms per `all()` at 2,000 files; with `watch: false` it costs 0.005 ms. A file deleted and recreated with the same size and modification time is also read again, where a parse cached before the deletion used to be returned.
