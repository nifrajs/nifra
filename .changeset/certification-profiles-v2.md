---
"@nifrajs/testing": minor
---

The cache, job and storage certification profiles now fail the adapters they should, and pass the ones they should. Each profile moves to version 2.

- **cache-store**: entries are fresh until 2100. A store that honors expiry on the wall clock used to fail, because the old entries expired in 1970.
- **job-store**: a new `lease-exclusive` check, under `lease-complete`. A leased job must stay hidden from other workers until its lease runs out, and then come back. A store that handed one job to every worker used to pass.
- **storage-adapter**: a new required `key-safety` capability. `put`, `get`, `exists` and `delete` must refuse a `..` segment, an absolute key, a backslash, a NUL, and an empty, `.` or trailing segment, as `@nifrajs/storage`'s key contract does.
