---
"@nifrajs/a2a": patch
"@nifrajs/ag-ui": patch
"@nifrajs/agent": patch
"@nifrajs/agent-app": patch
"@nifrajs/agent-review": patch
"@nifrajs/auth": patch
"@nifrajs/cli": patch
"@nifrajs/client": patch
"@nifrajs/core": patch
"@nifrajs/middleware": patch
"@nifrajs/node-uws": patch
"@nifrajs/proxy": patch
"@nifrajs/storage": minor
"@nifrajs/web": patch
"create-nifra": patch
---

`FileStorage.get` now buffers at most 16 MiB per object and 16 MiB per metadata file, and throws a `RangeError` above either limit. `put` is not limited, so to read larger entries pass `new FileStorage(root, { maxReadBytes, maxMetadataBytes })`. Check request authorization before replaying agent evidence. Support batched session-store reads. Reduce work in CLI startup, MCP worker reuse, proxy forwarding, logging, client header merges, and server queues. Reject malformed scaffold arguments before creating files and make CLI help easier to scan.
