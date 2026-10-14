---
"@nifrajs/image": patch
---

A local source with a hidden name (a segment starting with `.` other than `.well-known`) is 404 `source_not_found`, whether requested directly or through a link to it, as `@nifrajs/web` does for public files. With `root: "./public"`, `src=.env` answered 415 while a missing file answered 404, which told a caller the file existed, and a hidden image such as `.git/x.png` was transformed and served.
