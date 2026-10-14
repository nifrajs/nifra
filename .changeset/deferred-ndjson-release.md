---
"@nifrajs/web": patch
---

A soft navigation's deferred data stream is cancelled and released when a line fails to parse. A malformed first line threw out of `parseNdjsonData` with the body still locked and streaming and the abort listener attached, and a malformed later line stopped reading without cancelling the body; every exit now detaches from the signal, cancels an unfinished body and releases the reader.
