---
"@nifrajs/node": patch
"@nifrajs/image": patch
"@nifrajs/web": patch
---

Static files, `public/` files and local image sources refuse a resolved path when any directory along it became a symlink between the containment check and the open. On macOS the open itself refuses such a path; on Linux the opened descriptor's path is checked; elsewhere the opened file must still be the one at the checked path. Before, only a symlink in the last component was refused. A refused `public/` file falls through like a missing one.
