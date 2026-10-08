---
"@nifrajs/cli": major
---

`nifra check` findings are silenced with one comment form: `// nifra-expect <code>: <reason>`, on the flagged line or anywhere in the comment block directly above it. It answers only the code it names. Every security finding (NF-S001 to NF-S006) and every error needs the reason; an advisory accepts the comment without one. The names `sql-dynamic` (NF-C006), `raw-response` (NF-C007), `reserved-segment` (NF-C018), `route-overlap` (NF-C024, NF-C025) and `param-modifier` (NF-C026) still work in place of the code, so `// nifra-expect route-overlap` now needs a reason too. A silenced security finding stays in the report as information, with the comment and its reason as evidence.

`@nifra-gate-reviewed` silences nothing: the finding under it fails as any other and names the comment to write instead. `nifra upgrade 5.0.0` lists every such comment with the line it covered and never writes a reason.
