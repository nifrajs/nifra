---
"@nifrajs/node": patch
"@nifrajs/core": patch
---

Node serving got measurably faster - ahead of Fastify on every workload in our benchmark, where it previously trailed by ~2%. Three changes, all behavior-preserving:

- Buffered responses (node-direct JSON and SSR body outcomes) now declare `Content-Length` instead of falling back to `Transfer-Encoding: chunked` - a known-length body never needed chunked framing, which cost extra wire bytes and client parsing on every response, and no other runtime chunked these.
- The socket-peer platform object is built once per connection and reused across keep-alive requests (the peer address cannot change mid-socket).
- Routing on Node now splits pathname/search straight from the origin-form request target; the absolute URL is only synthesized if something actually reads `c.req.url`. `RequestSource` gained an optional `urlParts` field for sources that already hold the split target.
