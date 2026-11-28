---
"@nifrajs/core": minor
"@nifrajs/node": minor
"@nifrajs/node-engine": minor
"@nifrajs/node-engine-darwin-arm64": minor
"@nifrajs/node-engine-darwin-x64": minor
"@nifrajs/node-engine-linux-arm64-gnu": minor
"@nifrajs/node-engine-linux-arm64-musl": minor
"@nifrajs/node-engine-linux-x64-gnu": minor
"@nifrajs/node-engine-linux-x64-musl": minor
"@nifrajs/node-engine-win32-x64": minor
"@nifrajs/storage": minor
---

Fix request AsyncLocalStorage isolation, preserve serve() ALS scope across handlers, support TRACE, c.trailers, 103 Early Hints, CONNECT tunnels, mTLS client certificates, node:http Express compatibility and diagnostics_channel instrumentation, publish @nifrajs/node-engine with platform prebuilt binary packages, and add StreamableStorageAdapter (head, getStream, putStream) to @nifrajs/storage.
