---
"@nifrajs/coding-agent": patch
---

`ContextWindow` compaction keeps pinned and authoritative records, newest first, within half of `maxTokens` and folds older ones into the summary, and the summary is no longer than `maxTokens` characters. A long run of approvals no longer grows the window past its bound; the session store still keeps every record.
