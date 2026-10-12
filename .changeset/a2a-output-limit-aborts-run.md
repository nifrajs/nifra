---
"@nifrajs/a2a": patch
---

A `SendStreamingMessage` stream that reaches `maxOutputBytes` now aborts the run it carries, the same way a client disconnect does. Before, the stream sent its `output_limit` error and closed while the run kept going in the background, calling the model for every remaining turn with nobody reading the result.
