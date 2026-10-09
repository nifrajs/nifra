---
"@nifrajs/core": patch
---

`reflectHooks` (and so `nifra routes --hooks`) finishes on an app that mounts itself, or two servers that mount each other. It used to follow the mount without end and never return. A mount of a server already on the path is now reported once, as that prefix's unmatched entry.
