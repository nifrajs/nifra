---
"@nifrajs/storage": patch
---

`FileStorage.list()` now starts below the directories its `prefix` names and stops once it has `limit` keys, walking entries in key order. It used to read the whole tree, then sort and filter, for every call.
