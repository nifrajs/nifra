---
"@nifrajs/storage": patch
---

`FileStorage.list()` refuses with `StorageKeyError` when the storage root, or a directory the walk is entering, has been replaced by a symlink, instead of listing names from wherever the link points. Each directory is opened and checked against the root and its trusted parents before its names are returned: read through the open descriptor on Linux, and checked by identity before and after the read elsewhere. A missing directory still lists as empty.
