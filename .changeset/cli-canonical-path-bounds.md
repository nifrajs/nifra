---
"@nifrajs/cli": patch
---

The two CLI paths that bound a caller-supplied path to the project root now resolve it through the
filesystem instead of comparing strings. `loadBackend`'s entry check and `resolveProjectDir` both
compared the textual path, so a symlink inside the project pointed anywhere and still read as inside -
and importing an entry executes it. Both now canonicalize with `realpath` before the containment test
(`resolveProjectDir` walks up to the deepest existing ancestor, so a not-yet-created directory still
resolves), and the test itself covers the Windows cross-drive case where `relative()` returns an
absolute path that starts with neither `..` nor a separator.

`nifra init-agents` refuses to write through a symlink: a symlinked ancestor directory or a symlinked
target file aborts with an error rather than landing the file wherever the link points. Writes are
also atomic (temp file plus rename, `wx` so the temp cannot follow an existing name), so an
interrupted run can no longer leave a half-written config behind.
