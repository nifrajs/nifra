---
"@nifrajs/storage": minor
---

`R2Storage.list()` returns every key (up to `limit`), following R2's cursor past the 1000 keys a single bucket `list()` call returns. Before, it stopped at the first page, so a cleanup that deleted "everything listed" left the rest behind. `R2Storage` also implements `listPage()`, which returns one page of at most 1000 keys and the opaque cursor for the next.
