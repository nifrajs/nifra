---
"@nifrajs/cli": minor
---

`nifra check` accepts `// nifra-expect NF-C002: <reason>` on a hand-rolled `fetch`, `EventSource` or `WebSocket` call to the app's own API, for a call no typed client covers, such as a static file or a foreign handler's endpoint. The finding stays in the report as `info`, with the comment as evidence. A comment with no reason after the colon silences nothing, and the error says so.
