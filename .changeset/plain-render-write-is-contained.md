---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

A plain render that Node refuses to write now answers 500 and leaves the server serving, and `status()` rejects an out-of-range code where it is written.

The plain lane goes straight to the socket, so a header value never passes through the `Headers` constructor that rejects CR/LF on the Web lane. Node rejects it at `writeHead` instead - as it does an invalid status, or any write after the head is already out. On the synchronous lane that throw escaped the request; on the asynchronous ones it surfaced as an unhandled rejection, which by Node's default terminates the process, so an application reflecting request data into `c.set.headers` or `status(...)` had a route-shaped input that could take the server down. Every write is now contained: an unsent head becomes the ordinary flat 500, and a head already on the wire ends the connection, because a status line cannot be recalled and a half-written body must not be left for the client to parse.

`status(code, ...)` now throws a `RangeError` for a code outside 200-599 or a non-integer. A plain render carries its status to `writeHead` unexamined, so an out-of-range value used to fail at the socket, far from the handler that produced it.
