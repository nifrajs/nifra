---
"@nifrajs/web": patch
---

The credential scan no longer reads a ternary as an assignment. In
`mode === "signup" ? "new-password" : "current-password"` the tail of `"new-password"` was taken for a
key named `password`, and in `ready ? config.apiKey : "..."` the branch was taken for an `apiKey:` key,
so a client build and `nifra check` (NF-C032) failed on a plain string. A quoted name must now be the
whole string, and a name after a ternary's `?` or a member access's `.` is not a key. An object key
inside a ternary branch, a quoted JSON key and a property assignment are still checked.
