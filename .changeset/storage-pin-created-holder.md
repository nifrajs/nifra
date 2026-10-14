---
"@nifrajs/storage": patch
---

`FileStorage` pins the directory holding its root as soon as that directory exists. When the root's parent was missing at first use, the pin stayed on a higher ancestor, so swapping a directory the first put created for a link redirected later reads and writes into another tree; such an operation now fails with `StorageKeyError`.
