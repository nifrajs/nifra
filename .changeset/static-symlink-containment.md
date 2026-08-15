---
"@nifrajs/node": patch
---

A static file is resolved, containment-checked, and opened as one step that a symlink swap cannot race.

The lexical `..` guard on the requested path cannot see a symlink inside the served tree that points outside it, and the follow-up defence resolved the path, checked it, and then opened the original name - a window a local attacker who can write inside the tree wins by swapping a link between the check and the open, so the descriptor streams an external file while the check answered on a contained path. The served path is now resolved with `realpath`, the containment check runs on that resolved name, and the resolved name is opened with `O_NOFOLLOW`, so a link appearing on the final component after the resolve is refused rather than followed. A non-regular file (a directory, a device) still answers 404 from its opened descriptor's own stat, not from a separate lookup.
