---
"@nifrajs/web": minor
---

`"nifra": { "zones": ... }` accepts single files and nested paths: an entry inside another entry's folder overrides it, so the most specific path decides a file's side (`"frontend": ["src/ui"], "backend": ["src/ui/mailer.ts"]`). Only one path listed under two sides is refused. Before, any two entries that overlapped were refused, and a file in a mixed folder could only move. A suffix that disagrees with a configured path names that path in the error.
