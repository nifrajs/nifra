---
"@nifrajs/client": patch
---

Header names now merge in any letter case. A client `Authorization` header and a per-call `authorization` header were both sent, joined into one value; the per-call one now replaces it, as does a header `onRequest` returns. A body the client encodes carries the codec's `content-type` alone, a caller's `Accept` is kept over a transport codec's, and `.subscribe()` sends one value for each name.
