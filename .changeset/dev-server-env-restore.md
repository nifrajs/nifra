---
"@nifrajs/web": patch
---

Restore the dev-phase environment flags a programmatically started dev server sets when it stops, so a later in-process consumer sharing the process does not read them as if a dev server were still running.
