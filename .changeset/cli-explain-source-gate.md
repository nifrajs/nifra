---
"@nifrajs/cli": patch
---

`nifra_explain` shows a codeframe only from project source files. A stack frame naming a dotfile or anything under a dot directory, such as `.env` or `.git/config`, gets no source excerpt.
