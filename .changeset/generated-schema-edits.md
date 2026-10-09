---
"@nifrajs/cli": patch
---

A `nifra:generated` output schema that was edited by hand is no longer reported as current. Before, `nifra schemas` and `nifra check` (NF-C033) compared only the hash in the marker line with a fresh render. The marker still matched after an edit, so a schema widened to `t.json()` passed. Both now also compare the schema's text with what `nifra schemas --write` would write. Reformatting, comments, quote style, quoted keys, trailing commas and semicolons do not count as edits. An edited schema is reported as stale with `edited: true`, and `--write` restores the generated version.
