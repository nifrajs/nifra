---
"@nifrajs/auth": minor
---

`SessionStore` gains an optional `replace(id, record)` method that overwrites `id` only while it still holds a record and resolves whether it wrote. When a store implements it, a loaded session renews through `replace` instead of `set`, so a logout that lands between the commit's checks and its write wins, even once the logout's revocation marker is gone. Implement it as one atomic step that also sets the new expiry, such as Redis `SET key value XX PXAT <record.expiresAt>` (a bare `XX` drops the key's TTL) or a SQL `UPDATE ... WHERE id = ?` that reports the rows it changed. `MemorySessionStore` implements it. A store without it works as before and must keep each revocation marker until its `expiresAt`, as `KVSessionStore` does: Workers KV has no conditional write.
