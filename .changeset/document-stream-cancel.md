---
"@nifrajs/web": patch
---

When a client disconnects mid-response, the streamed HTML document now cancels the framework renderer's stream instead of leaving it running, and neither the document nor the navigation data stream writes a deferred value that settles afterwards. Before, each such value logged a spurious "deferred value rejected" error.
