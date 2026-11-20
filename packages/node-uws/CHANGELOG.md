# @nifrajs/node-uws

## 5.16.0

### Patch Changes

- 50718d5: Evidence streams, subscription sinks, the admission queue, uploads and the OTLP export queue dequeue in constant time, so a deep backlog costs no more per item.
- 14a9a00: Replies no longer carry the `uWebSockets: 20` header. uWS's banner is switched off for the thread's event loop when the adapter loads it; a worker thread switches off its own by loading the adapter.

## 5.15.1

No changes in this release.

## 5.15.0

### Minor Changes

- 1d956e6: `staticResponse()` GET routes are answered by uWS itself, without a call into JavaScript, and fixed POST routes without building a request (a POST carrying an `Origin` header still goes through the cross-site form check), whenever nothing in the app can observe the request (no request or response hook, deadline, capacity gate, Host policy, schema, auth or other route-level stage). New `echoParam(path)` answers a GET route with its final path parameter as text, exactly as sent (percent-escapes kept), so node-uws can answer that route natively too when no other route can overlap it. Serving an app now seals it, as `listen()` does, so a hook or route added afterwards throws `SERVER_SEALED` instead of being skipped on those paths.

## 5.14.0

### Minor Changes

- b8e98c0: `@nifrajs/node` has a `./transport` entry exposing its outcome runtime, Host and target policy, and lifecycle hooks to sibling HTTP adapters; `serve()` and the package's exports are unchanged. The new `@nifrajs/node-uws` serves a nifra app on uWebSockets.js through the same node-direct lane, with streaming responses, back-pressure, graceful `stop()` and the Host and target rules of `@nifrajs/node`. It has no WebSocket or static-file support.

### Patch Changes

- ab4fa97: A handler that answers without reading an upload larger than 1 MiB no longer leaves the connection paused: the next request on it is read instead of waiting out uWS's idle timeout. Reading the body after the answer started now rejects.

## 5.13.0

### Patch Changes

- Serve a nifra app on uWebSockets.js through the node-direct lane of `@nifrajs/node`.
