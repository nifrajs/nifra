---
"@nifrajs/core": patch
---

The `protoPoisoning` option's documentation now matches what it does: every guarded JSON body pays one pass over its parsed object nodes, and `"ignore"` skips it. It used to promise that clean payloads paid only a text pre-scan, which the guard has not done since it began walking the parsed value.
