---
"@nifrajs/web": patch
---

The Vite dev bridge cancels a non-HTML response body when the client left before piping began, or while a write was refused. It waited for a `drain` that never came, so an SSE source or a streamed body from the app stayed open for every aborted request.
