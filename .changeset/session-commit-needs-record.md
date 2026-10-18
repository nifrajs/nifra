---
"@nifrajs/auth": patch
---

A store-backed session that a request loaded before a logout or rotation can no longer be written back by that request's later `commit()`. A loaded session now commits only while its record still exists and no revocation marker names it, so the guarantee no longer depends on the logout's marker outliving the request: other revocations pushing that marker out of a bounded `MemorySessionStore` cannot bring the session back, and neither can a commit that reads between a logout's marker write and its delete. The commit reads the record and the marker in parallel, so it waits on no extra store round trip. A `MemorySessionStore`, which can evict markers, also makes the renewal itself conditional: it writes only while the record still exists, in one step with the check, so a logout that lands after the commit's reads still wins.
