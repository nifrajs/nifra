---
"@nifrajs/cli": patch
---

feat(contracts): `contracts.lock.json` records the digest format it was hashed with. A lock from another format fails `nifra contracts check` (NF-K001) with one "re-snapshot" diagnostic instead of reporting every route as changed, and a lock without a format notes that it may predate the 4.0.1 rehash when it reports drift.
