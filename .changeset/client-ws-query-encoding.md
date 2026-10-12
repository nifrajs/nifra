---
"@nifrajs/client": patch
---

A `.ws()` handshake now encodes its `query` the way an HTTP call does: an array repeats its key once per item and an `undefined` value is left out. Before, `{ tag: ["a", "b"], room: undefined }` reached the server as `tag=a%2Cb&room=undefined`, so a WebSocket route read a joined string and the literal text "undefined". The `query` type now accepts arrays and `undefined` values to match.
