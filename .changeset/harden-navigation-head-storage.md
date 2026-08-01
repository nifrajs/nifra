---
"@nifrajs/storage": patch
"@nifrajs/web": patch
---

Harden browser navigation, route-owned head descriptors, and filesystem deletion boundaries.

Programmatic navigation now validates targets before blockers inspect them, ignores malformed and
cross-origin destinations, and preserves the existing hard-load fallback only for unmatched
same-origin routes. Route-owned link descriptors accept only relative or HTTP(S) `href` values and
fail closed on hostile runtime values, getters, and proxies.

`FileStorage.delete()` now rejects directory chains another local principal can replace. On Linux,
the final unlink is anchored to a validated open parent-directory descriptor so a concurrent path
swap cannot redirect deletion outside the storage root.
