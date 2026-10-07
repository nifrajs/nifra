---
"@nifrajs/cli": patch
---

`nifra check` and `nifra doctor` read a regex literal that contains a quote or backtick as a regex, so the code after it is no longer misread as a string or a template.
