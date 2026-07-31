---
"@nifrajs/storage": patch
---

The beacon wrapper survives a frozen adapter, and file writes cannot be raced onto a symlink.

A Proxy may not report a different value for a non-writable, non-configurable own property, so wrapping
a frozen adapter whose methods are own properties threw a Proxy invariant error before the wrapper
could run - measured, not theorised. The beacon now proxies an extensible facade and delegates every
read, write and call to the real instance, so `instanceof`, `#private` brands and frozen adapters all
keep working. Methods are cached per wrapper, so repeated property reads keep their identity and
allocate once.

`FileStorage` opened its target with `O_TRUNC` after checking the path, which leaves a window between
the check and the open: winning it pointed the descriptor at a file outside the storage root and
truncated it. The open no longer truncates. The descriptor is compared against the path's current inode
and its resolved location is confirmed to be inside the root, and only then is anything destroyed.
