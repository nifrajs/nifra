---
"@nifrajs/cli": patch
---

`nifra sdk --lang go` writes a property's JSON name into a struct tag only when Go's `encoding/json` can read it there. A property name with a quote, backslash, backtick, comma or control character has no struct-tag spelling. Such a field is left out and reported like any other unsupported schema, and `--strict` refuses the document. A property named `-` is tagged `json:"-,"`, so it is no longer dropped.
