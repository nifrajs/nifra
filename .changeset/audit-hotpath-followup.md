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
"@nifrajs/storage": patch
"@nifrajs/web": patch
"create-nifra": patch
---

Bound buffered file and metadata reads and check request authorization before replaying agent evidence. Support batched session-store reads. Reduce work in CLI startup, MCP worker reuse, proxy forwarding, logging, client header merges, and server queues. Reject malformed scaffold arguments before creating files and make CLI help easier to scan.
