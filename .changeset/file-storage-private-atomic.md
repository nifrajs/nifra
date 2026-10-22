---
"@nifrajs/storage": patch
---

`FileStorage` keeps its bookkeeping beside the root (`<root>.nifra-state`), where staged bytes and
sidecars live, private to its owner, and closes such a tree left open by an earlier version on its
first write. On a root that is its own mount point, a put is staged next to the object under a name
no key can have and renamed over it, so a failed write leaves the previous object whole and a reader
never sees part of one; `list()` skips such names. On Windows such a root refuses the put instead of
writing in place.
