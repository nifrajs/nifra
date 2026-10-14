---
"@nifrajs/client": patch
"@nifrajs/core": patch
---

An in-process client reads a handler's streamed body under `maxDecodedBytes`, cancelling it once past the cap, as a network client does. It used to read every in-process body whole and check the size afterwards, which is safe for a body the app serialized but let a route returning its own `ReadableStream` buffer without limit before the check. A body the framework serialized keeps the whole-read lane: core records it when an in-process client exists (`hasResidentBody` from `@nifrajs/core/mount`).
