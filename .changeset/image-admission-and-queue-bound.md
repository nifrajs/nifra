---
"@nifrajs/image": minor
---

The image handler now admits requests before it reads a source, and the queue is bounded. Previously
the source was fetched and buffered first and only the codec work was limited, so every queued request
held a full source buffer while it waited - unbounded, since nothing capped the queue. Two lanes
replace the single semaphore: `sourceConcurrency` (default `concurrency * 2`) admits a request for its
whole lifetime and bounds live source buffers, and the codec lane is taken only around probe and
transform, so a slow remote origin can no longer occupy a CPU slot for the length of a network wait.
Beyond `maxQueue` (default `concurrency * 16`) waiting requests, the handler answers
`503 image_queue_full` rather than queueing without limit. The memory ceiling is now explicit:
`sourceConcurrency * maxSourceBytes`, 160 MiB at the defaults.
