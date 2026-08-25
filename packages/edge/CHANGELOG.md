# @nifrajs/edge

## 3.3.0

## 3.2.0

### Patch Changes

- 87272f3: Harden cross-runtime response handling and Node parser-error behavior for production agent hosts.

## 3.1.0

### Minor Changes

- 5b78473: New package `@nifrajs/edge`: a compact fetch-handler server for edge and serverless runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy, Bun). It keeps the `server().get().post()` DX and the full request trust boundary - bounded body read, Content-Length pre-reject, prototype-pollution guard, JSON / urlencoded framing - in a fraction of the bundle, and its rejection envelopes are byte-for-byte the full server's, so an app can graduate to `@nifrajs/core`'s `server()` without its clients noticing.

## 3.0.0

### Minor Changes

- Initial release: a compact fetch-handler server for edge and serverless runtimes. Keeps the `server().get().post()` DX and the full request trust boundary - bounded body read, Content-Length pre-reject, prototype-pollution guard, JSON / urlencoded framing - imported from `@nifrajs/core`, so the rejection envelopes are byte-for-byte the full Server's.
