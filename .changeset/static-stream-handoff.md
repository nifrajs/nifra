---
"@nifrajs/node": patch
---

Static files are handed to the socket as the file stream they already are, instead of being repackaged through a Web stream first.

Same hand-off the proxy path uses: the response body is still a real `ReadableStream` and is what any middleware or other consumer gets, and anything that touches it first takes the ordinary conversion instead. On a pinned-core Linux rig at 50 connections this is worth about 2% on a 64 KB asset (8618 to 8809 req/s, every sample separated); on a 1 KB asset the difference sits inside run-to-run noise. Static serving is dominated by filesystem work rather than by the conversion, so the gain is small by nature.

The file descriptor behind a served file is closed on the new path whether the response completes or the client leaves mid-body.
