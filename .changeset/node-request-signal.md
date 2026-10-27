---
"@nifrajs/node": patch
---

Reading `signal` on a Node request no longer builds the full undici `Request`. The signal still aborts when the client goes away before the response finishes, and a request built later follows it. Server-rendered pages read it on every document.
