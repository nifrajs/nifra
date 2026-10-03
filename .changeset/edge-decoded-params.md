---
"@nifrajs/edge": patch
---

Route params reach handlers decoded, as on the full server: `/files/a%20b` gives `name: "a b"`, and a malformed escape such as `/files/%E0%A4` answers `400 malformed_path`.
