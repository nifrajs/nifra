---
"@nifrajs/auth": patch
---

A store-backed session renewal on a store without `replace()` can no longer undo a logout. When the record it renews expires while the write is in flight, a logout in that gap finds nothing to revoke; the renewal now deletes what it wrote and sends no cookie instead of restoring the session.
