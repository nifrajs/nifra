---
"@nifrajs/node-uws": patch
---

A handler that answers without reading an upload larger than 1 MiB no longer leaves the connection paused: the next request on it is read instead of waiting out uWS's idle timeout. Reading the body after the answer started now rejects.
