---
"@nifrajs/cli": patch
---

`nifra check` reads a `nifra-expect` marker on a finding's own line only from that line's comment. A marker inside a string literal on the flagged line, such as `token === expected ? "nifra-expect NF-S002: ..." : ""`, no longer silences or downgrades the finding.
