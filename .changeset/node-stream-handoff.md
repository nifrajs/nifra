---
"@nifrajs/node": patch
"@nifrajs/proxy": patch
---

Proxying on Node no longer repackages request and response bodies through Web streams when both sides of the hop are Node-native.

`@nifrajs/node` receives a Node `IncomingMessage` and must present a Web `Request`; `@nifrajs/proxy/undici` receives that `Request` and must hand undici a Node stream again. Nothing observable came of that round trip, but it was the bulk of the remaining distance to `@fastify/reply-from`, which never leaves Node streams. Measured on a pinned-core Linux rig against a local origin at 50 connections, as a share of what the origin serves unproxied: GET went from 22.3% to 25.7% (fastify 24.1%) and POST from 21.0% to 26.4% (fastify 26.8%).

Nothing changes for callers. The Web view is still a real `ReadableStream` and is what any other consumer gets; the hand-off happens only when the receiving layer is going to write those bytes to a Node stream anyway, and only while the Web view is untouched. A body that has been read, is held by a reader, or has already been handed over takes the ordinary conversion instead, so a body can never be split between the two views.

Also fixed on the way: an upstream body destroyed for a client that disconnected mid-request could raise an unhandled stream error and terminate the process.
