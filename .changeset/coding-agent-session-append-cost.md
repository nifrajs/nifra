---
"@nifrajs/coding-agent": patch
---

`FileSessionStore.append` keeps a running count of each session file's entries and bytes, so an append under `maxEntries` and `maxBytes` no longer reads the log back. When a log passes either cap, it is compacted down to three quarters of both caps, so the next rewrite is many appends away instead of on every append.
