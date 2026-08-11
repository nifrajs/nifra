---
"@nifrajs/core": patch
---

The body-size cap now holds on the bytes actually delivered, not on what the request declared.
The `Content-Length` fast path re-checks the real byte count after the read: a source that hands
over more bytes than it declared - a lying client or an adapter that decodes/expands the body
upstream - is rejected with the same flat `413`, even though its header passed the fast-reject
hint. One integer comparison on a buffer already in hand; the streaming lane already counted real
bytes and is unchanged.
