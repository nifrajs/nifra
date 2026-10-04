---
"@nifrajs/coding-agent": patch
---

On Windows, a session id containing `:` (including the default `<id>:fork:<time>` id `FileSessionStore.fork()` makes) is stored under a file name with `:` written as `%3A`, so forks, checkpoints and session migration no longer address an NTFS alternate data stream. File names on other platforms are unchanged.
