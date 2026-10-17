---
"@nifrajs/client": minor
"@nifrajs/cli": minor
---

`.ws()` on the typed client takes `validateReceive`: the route's `sendSchema`, checked against every received frame. A frame that fails is not delivered, and `onError` gets a `TypeError` naming the issues with the frame as its `cause`. Frames keep their arrival order with an async schema too. Without the option nothing changes.

`nifra check` reports `NF-S009` (info) for an `app.ws()` route whose inline `message()` calls `JSON.parse` with no `messageSchema`.

`nifra_docs` answers a query that matches a long page with that page's lead, the `###` subsections the query matches, and the headings of the rest, where it returned the page's first 2,800 characters. The WebSockets guide gains a typechecked example (`nifra_example`) with discriminated-union `messageSchema` and `sendSchema`, the client's `.ws()` handle, an exhaustive `switch` with a `never` check, and a heartbeat the client answers.
