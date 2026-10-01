---
"@nifrajs/core": minor
---

feat(core): a second copy of `@nifrajs/core` in one process is named when it loads. Two installed
copies (a linked sibling checkout, a nested install) keep separate request state, so a route from
one copy's `server()` merged into the other failed per request with an internal TypeError. The
second copy now prints `[nifra] @nifrajs/core is loaded 2 times` with the path of each copy, and
`.merge()` throws `merge() requires a server() from this copy of @nifrajs/core` at configuration
time for a server from another copy or any value that is not a `server()`. `mount()` crosses only
the fetch boundary and keeps working across copies. A dev server re-evaluating the same file is
one copy. `nifra check` remains the gate that fails the build on a duplicate install.
