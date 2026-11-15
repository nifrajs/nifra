# @nifrajs/node-uws

## 5.14.0

### Minor Changes

- b8e98c0: `@nifrajs/node` has a `./transport` entry exposing its outcome runtime, Host and target policy, and lifecycle hooks to sibling HTTP adapters; `serve()` and the package's exports are unchanged. The new `@nifrajs/node-uws` serves a nifra app on uWebSockets.js through the same node-direct lane, with streaming responses, back-pressure, graceful `stop()` and the Host and target rules of `@nifrajs/node`. It has no WebSocket or static-file support.

### Patch Changes

- ab4fa97: A handler that answers without reading an upload larger than 1 MiB no longer leaves the connection paused: the next request on it is read instead of waiting out uWS's idle timeout. Reading the body after the answer started now rejects.

## 5.13.0

### Patch Changes

- Serve a nifra app on uWebSockets.js through the node-direct lane of `@nifrajs/node`.
