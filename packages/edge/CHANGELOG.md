# @nifrajs/edge

## 3.0.0

### Minor Changes

- Initial release: a compact fetch-handler server for edge and serverless runtimes. Keeps the `server().get().post()` DX and the full request trust boundary - bounded body read, Content-Length pre-reject, prototype-pollution guard, JSON / urlencoded framing - imported from `@nifrajs/core`, so the rejection envelopes are byte-for-byte the full Server's.
