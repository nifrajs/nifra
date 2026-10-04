---
"@nifrajs/storage": minor
---

`FileStorage` works on a host whose umask is `002`, the default for ordinary users on Debian and Ubuntu. The directories it creates are `0755` whatever the umask, and a group-writable directory it still refuses is named in the error, with the fix. A directory under the root is a key prefix, not an object: `exists()` is `false`, `get()` is `null`, and `delete()` does nothing.

Every adapter now refuses a key with an empty or `.` segment (`a//b`, `./a`, `a/./b`, `a/`). A file system reads such a key as another key, while an object store keeps the two apart.
