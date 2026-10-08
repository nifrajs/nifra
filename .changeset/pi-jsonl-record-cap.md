---
"@nifrajs/pi": patch
---

`maxRecordBytes` bounds each Pi JSONL record and the record still arriving, so a single stdout chunk that carries several records under the cap is accepted rather than failing as an oversized record.
