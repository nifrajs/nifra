---
"@nifrajs/web": patch
"@nifrajs/core": patch
"@nifrajs/content": patch
---

A failed boundary load no longer publishes the thrown error's own message. Boundary states are serialized into the document, so a driver or fetch failure was putting hosts, credentials, and query text on the page for every visitor who loaded it while the dependency was down. The client slot is now always `Boundary failed`, an `Error` subclass name is withheld for the same reason it names the failing internal library, and the real error is reported to the server console - the split already used for a rejected deferred value. A boundary that wants to show the user something specific catches its own failure inside `load` and returns that as data.

Opt-in outbound WebSocket validation (`validateSend`) contains a rejected diagnostic instead of recursing. An `error()` handler that answers a dropped frame by sending one of its own re-entered the reporter through the two paths that bypassed its guard - schema rejection and an async validator - and unwound only when the stack was exhausted, silently. Every failure path now reports through the guard.

A content index cursor is checked for the query that issued it separately from running off the end: a cursor from a different sort or filter is rejected at any position, and a matching cursor left past the last row by an index that shrank between pages returns an exhausted page rather than throwing.
