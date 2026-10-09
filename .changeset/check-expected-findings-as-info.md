---
"@nifrajs/cli": patch
---

`nifra check` keeps an interpolated-SQL site that a `// nifra-expect NF-C006: <reason>` comment silences in the report, as information carrying the comment's reason, as it already did for silenced security findings. A silenced finding from a rule outside the named sections is now reported with severity `info` instead of `warning`, and a report section that holds only information is marked `•` and `(info)` instead of the warning sign.
