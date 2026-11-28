---
"@nifrajs/node-engine": patch
---

HTTP/2 now follows RFC 9113 and RFC 7541 where it was lenient: frames on idle or closed streams, self-dependent priorities, an invalid `ENABLE_PUSH` value and a late HPACK table size update close the connection. A GOAWAY is no longer lost to a reset when the peer is still sending, and a TLS connection that negotiated `h2` is answered as HTTP/2 even if its preface is wrong. On Windows, a second server can no longer bind a port that is already being served. Rebuild the native addon together with the package.
