---
"@nifrajs/cli": patch
---

`nifra migrate layout` lists every line where a workspace sibling names a moved app file, not only the first. A sibling that names the path in code is an issue whose message gives each code line and any comment lines beside them; a sibling that names it only in comments is a follow-up, as a comment inside the app already is.
