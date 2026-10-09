---
"@nifrajs/content": patch
---

`defineCollection` reads the directory, stats and files with async file IO. It used the synchronous calls inside `all()` and `get()`, which blocked a long-lived server's event loop for the whole read.
