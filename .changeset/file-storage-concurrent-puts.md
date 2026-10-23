---
"@nifrajs/storage": patch
---

`FileStorage` no longer refuses a put or read of a key that another instance replaces at the same
moment. Its containment check resolves the directories above a stored object and holds the object
itself to a plain file, so it does not depend on the object keeping one inode while it runs. Bun
1.4.4 on Linux fails `realpath` for a file that a concurrent rename replaces.
