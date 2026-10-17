---
"@nifrajs/auth": patch
---

A store-backed session that a request loaded before a logout or rotation can no longer be written back by that request's later `commit()`. A loaded session now commits only while its record still exists, so the guarantee no longer depends on the logout's revocation marker outliving the request: other revocations pushing that marker out of a bounded `MemorySessionStore` cannot bring the session back. The commit makes the same number of store reads as before.
