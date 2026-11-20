---
"@nifrajs/agent": patch
"@nifrajs/graphql": patch
"@nifrajs/middleware": patch
"@nifrajs/node-uws": patch
"@nifrajs/otel": patch
---

Evidence streams, subscription sinks, the admission queue, uploads and the OTLP export queue dequeue in constant time, so a deep backlog costs no more per item.
