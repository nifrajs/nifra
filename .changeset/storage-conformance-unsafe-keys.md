---
"@nifrajs/storage": patch
---

`assertStorageAdapterConformance` checks every key shape the storage key contract refuses, on every key-taking method: a nested `..` segment, an absolute key, a backslash, a NUL, an empty key, and an empty, `.`, or trailing segment, where it used to try `../escape` alone. An adapter that refuses only some of them fails the `key safety` check with the method and key named.
