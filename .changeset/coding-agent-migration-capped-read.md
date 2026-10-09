---
"@nifrajs/coding-agent": patch
---

`migrateLegacySession` now stops reading a legacy session file as soon as it passes `maxSourceBytes`, instead of reading the whole file into memory before checking. The committed target is re-read against its expected size the same way.
