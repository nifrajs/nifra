# @nifrajs/node-engine

**Experimental, private, not for release.** Serve a nifra app from Node on Nifra's own Rust engine (`native/nifra-engine`): a native HTTP/1.1, HTTP/2 and WebSocket server with in-process TLS, polled by Node's libuv loop and reached through a N-API addon (`nifra-napi`).

It is a sibling of `@nifrajs/node` and `@nifrajs/node-uws`. The engine hands requests over in batches through shared buffers, with the head and body complete, so requests reach the app through the node-direct lane with no `http.Server` underneath and no Web `Request` unless a route asks for one.

```ts
import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node-engine"

const app = server().get("/hello", () => ({ hello: "world" }))
const running = await serve(app, { port: 3000 })
// later
await running.stop()
```

Requires Node 22 or newer and the built addon. `@nifrajs/node` is a peer dependency: this package reuses its Host policy, lifecycle and outcome runtime.

Build `nifra-napi` with Cargo from `native/nifra-engine`; `serve()` loads it on first use from `native/nifra-engine/target/{release,debug}`, or from the path in `NIFRA_RUST_ENGINE_PATH` when set. The loader opens the shared library in place. It is unix-only (libuv poll handles).

Run the integration tests from the repository root. On macOS:

```sh
cargo build --release --manifest-path native/nifra-engine/Cargo.toml -p nifra-napi
bun run --filter @nifrajs/node-engine build
cp native/nifra-engine/target/release/libnifra_napi.dylib /tmp/nifra_napi.node
NIFRA_RUST_ENGINE_PATH=/tmp/nifra_napi.node node --test packages/node-engine/test-node/*.test.ts packages/node-engine/test/rust-runtime.test.mjs
```

On Linux, use `libnifra_napi.so`.

Set `NIFRA_ENGINE_TEST_DENO=1` with Deno on `PATH` to include the live adapter comparison in
`parity.test.ts`. CI enables this comparison.

## `serve(app, options)`

Resolves to an `EngineServer` once the port is bound. Invalid options throw before anything is started.

| Option | Meaning |
|---|---|
| `port` | Required. `0` picks a free port; read it from `running.port`. |
| `hostname` | Interface to bind. Default: all. |
| `protocol` | The scheme `Request.url` carries. `"https"` when `tls` is set, else `"http"`. |
| `tls` | In-process TLS (rustls): inline `cert` / `key`, or `cert_file_name` / `key_file_name`, plus optional `ticketKeys` (one or more 48-byte entries, newest first). |
| `http2` | HTTP/2 beside HTTP/1.1 on the same port. `true`, or an object of settings. See below. |
| `maxBodySize` | Largest request body, in bytes. Default 1 MiB. See below. |
| `oversizeWindow` | Bytes past `maxBodySize` still buffered so the app can answer with its own 413 body. Default 1 MiB; `0` turns it off. See below. |
| `wsMaxMessageSize` | Largest WebSocket message before the engine fails the connection with 1009. Default: see below. |
| `allowedHosts`, `canonicalHost`, `normalizeTarget` | The same Host and target policy `@nifrajs/node` applies. |
| `validateHost` | `true` checks every request's `Host`. Off by default, as on the Bun and Deno server; setting `allowedHosts` or `canonicalHost` turns it on. See below. |
| `engine` | Engine limits: `idleTimeoutMs` (default 30 s; also drops a peer that takes none of its response, and a quiet WebSocket is pinged first), `headersTimeoutMs` (default 60 s, request head and TLS handshake), `requestTimeoutMs` (default 300 s, from a request's first byte), `maxHeaderBytes` (default 16 KiB), `maxConnections`, `reusePort` (off; `serveCluster` sets it). |
| `gracefulSignals` | `true`, or stop options: SIGTERM and SIGINT call `stop()`. Off by default. |

`static` and `fastResponse` are not supported and throw a `TypeError`. Serve files from a route, or put a static host in front.

### The server handle

| Member | Meaning |
|---|---|
| `port` | The bound port. |
| `stop({ drainMs, delayMs })` | Runs the app's `onStopping` hooks, keeps serving for `delayMs`, stops accepting, lets in-flight requests and sockets finish for up to `drainMs` (default 10 s), closes what is left, then runs `onStop`. Open WebSockets are closed with 1001 "server shutting down". |
| `reloadTls(tls?)` | Swaps the certificate for every new handshake. See below. |
| `[Symbol.asyncDispose]()` | `await using` support; same as `stop()`. |

## Request bodies

The engine buffers a request whole before the app runs, so `maxBodySize` bounds the memory one request can hold. The default is 1 MiB, or the largest `maxBodyBytes` among the app and the apps mounted in it when that is more; a route with its own larger `schema.bodyLimit` needs `maxBodySize` set to match.

A body over `maxBodySize` gets a 413. The engine buffers up to `oversizeWindow` (default 1 MiB) past the cap so that a body only a little over it is answered with the same JSON body the app's own 413 carries (`{"ok":false,"error":"payload_too_large"}`), on a connection that stays usable. Past the window the engine refuses natively and closes the connection as the body passes it: a declared `Content-Length` is refused before any body is read, and a chunked upload is cut off a chunk or so past the window. That refusal has an empty body, which the engine gives no way to change. `oversizeWindow: 0` skips the window: every body over the cap is refused natively and the request path does no size check. A request therefore holds at most `maxBodySize` plus `oversizeWindow` in memory.

## Headers

The engine hands headers over one call at a time or all at once, and the second costs more the more headers a request carries. The request path asks for the few it needs (`Host`, `Content-Length`, `Content-Type`, `Transfer-Encoding`, `Upgrade`) and reads the whole list only if the app asks for another header or for `Headers`. A repeated `Content-Type` reads as its first value, as on Node; the engine refuses a repeated `Host`, a conflicting `Content-Length` and a repeated `Transfer-Encoding` before the app runs. A request's headers are read from the engine while it is being answered, so a handler still running after its client disconnected finds none that it had not already read.

### Host validation

Off by default, as `validateHost` is on the Bun and Deno server. With it off, `Host` is read only when `req.url` is asked for, as sent. It never takes part in routing here, which comes from the request target the engine parsed. A `Host` holding a path, query, fragment or userinfo delimiter is refused with a 400, and an empty one reads as `localhost`, so `req.url` never names a path the router did not see. What gets through is a `Host` the URL parser refuses, such as an out-of-range port: the request is answered, and reading `req.url` then throws.

`validateHost: true` reads and checks every request's `Host` before the app runs: a malformed one is refused with a 400, and `req.url` is built from the normalized authority. It costs one engine call per request. Turn it on for a server that clients reach directly. Behind a proxy or CDN that already checks `Host`, leave it off. `allowedHosts` and `canonicalHost` need every `Host` read, so setting either turns it on, and `validateHost: false` beside them is refused. Fixed replies answered inside the engine are skipped while it is on, since they would not be checked.

## Fixed replies

`staticResponse()` and `echoParam()` GET routes are registered with the engine, which answers them without calling into JS. They are skipped under a Host policy (every request's Host must be read) and a fixed POST stays on the router, where the cross-site form check can read `Origin` and `Sec-Fetch-Site`.

## HTTP/2

```ts
await serve(app, { port: 443, tls: { cert, key }, http2: true })
```

With `tls`, clients negotiate `h2` by ALPN. Without it, a client opening with the HTTP/2 preface is served (prior knowledge, `curl --http2-prior-knowledge`). Every other client gets HTTP/1.1 on the same port. A request on an HTTP/2 stream reaches the app exactly as an HTTP/1 request does.

Not served over HTTP/2: WebSocket upgrades (RFC 8441), server push, CONNECT. A WebSocket needs an HTTP/1.1 connection.

`engine.requestTimeoutMs` bounds reception of each HTTP/2 request from its initial headers.
An upload that exceeds the deadline is cancelled while other streams keep running.
If the deadline expires inside an unfinished frame or HPACK header block, the connection closes.

### HTTP/2 benchmarks

There are none yet. HTTP/2 here is covered by correctness tests only, and no throughput or latency figure for it has been measured or is quoted anywhere in this package. Figures for this repository's public pages come from the benchmark-accuracy CI run, not from a developer machine, and that run has no HTTP/2 target.

To measure it, use a client that speaks HTTP/2 and is not itself the limit:

```bash
# cleartext, prior knowledge
h2load -c 64 -m 10 -D 10 http://127.0.0.1:3000/hello
# TLS, negotiated by ALPN
h2load -c 64 -m 10 -D 10 https://127.0.0.1:3000/hello
# the same server over HTTP/1.1, for the comparison that matters
h2load -c 64 -m 10 -D 10 --h1 http://127.0.0.1:3000/hello
```

`h2load` ships with nghttp2. `oha --http2` and `bombardier --http2` also work, but on a fast server they run out of client before the server does, so a figure from them says little about the server. A comparison is only fair against another server on the same machine, with the same route, the same TLS settings, and `http2: true` on this one. Report the scope with every number: runtime and engine version, cleartext or TLS, connections and streams per connection, and whether the client was the bottleneck.

## WebSockets

An app that exposes `resolveWebSocketUpgrade` (every nifra app does) serves its `app.ws()` routes. A plain `{ fetch }` handler cannot, and a handshake to it is refused with 501.

- A guard's rejection answers the handshake with its own status, headers and body. A path with no socket route is answered by its HTTP route.
- Text arrives as a `string`, binary as a `Uint8Array`. A handler that throws reaches the route's `error()` and never ends the connection.
- `ws.close()` refuses a code or reason a server may not send, with a `RangeError`, as on the other adapters.
- `ws.raw` is an `EngineSocket`: `id`, `headers()`, `query()` and `remoteAddress()` of the handshake. The engine keeps no socket object to hand out.
- The engine takes one message cap per listener. Unless `wsMaxMessageSize` is set, it is the largest `wsMaxPayloadBytes` among the app and the apps mounted in it that serve sockets, else the engine's 16 MiB. A route whose app declares less is held to its own, and a message over it closes the socket with 1009.

The engine reports a peer's close code but not its reason, so `close(ws, code, reason)` gets `""` when the peer closed first. A close the server sent keeps its own reason.

## Certificate reload

```ts
running.reloadTls({ cert, key }) // a new certificate
running.reloadTls() // read the current files again
```

New handshakes, HTTP/1.1 and HTTP/2, get the new certificate; connections already open keep theirs. The argument is the whole `tls` shape, not a diff. With none, the current `tls` options are read again, which is how rotated certificate files are picked up. Session tickets carry over, so resumption survives the new certificate. It throws, leaving the certificate in place, on material the engine refuses, on a server without `tls`, and after `stop()`. Nothing watches the files; call it from a signal handler or a timer.

## Failed streams

When a streamed body fails after its head is out, the response is cut so the client sees a failure instead of a complete answer. The engine has no call that cuts one connection, so this uses two of its own behaviours:

| Response | HTTP/1.1 | HTTP/2 |
|---|---|---|
| Declared `Content-Length`, body falls short | Connection closed | Stream reset |
| No declared length | Connection closed, no chunk terminator | Ends cleanly: the protocol has no failed end to signal |

If a route streams something a client must be able to tell is incomplete, declare its length. The failure is also reported through the app's error hook.

## Clustering

```ts
import { serveCluster } from "@nifrajs/node-engine/cluster"

const node = await serveCluster(() => buildApp(), { port: 3000, workers: 4 })
if (node.role === "primary") {
  // node.workers(), node.stop(), node.restart(), node.reloadTls()
}
```

A primary process supervises worker processes that each run the engine on the same port with `SO_REUSEPORT`, so the kernel spreads accepted connections across them. The file runs in the primary and again in every worker, as with `node:cluster`; the app is built only in workers. `serveCluster` takes every `serve()` option plus:

| Option | Meaning |
|---|---|
| `workers` | Worker processes. Default: one per core. |
| `respawn` | Replace a worker that dies. Default `true`; a worker that keeps dying within seconds of starting is given up on after ten tries. |
| `onWorkerEvent` | Called in the primary with `listening` and `exit` events. |

The primary resolves once every worker is listening, and rejects after stopping the others if one cannot start. `stop()` and `gracefulSignals` drain every worker; one still alive well past the drain is killed. Workers share a set of TLS session-ticket keys, and the primary's `reloadTls()` reloads the certificate in every worker (PEM text or file names only, since it crosses a process boundary).

### Rolling restart

```ts
process.on("SIGUSR2", () => void node.restart({ drainMs: 10_000 }))
```

`restart()` replaces the workers one at a time: a new worker starts and is listening before the one it replaces is stopped, so the port is always served and capacity never drops. Each old worker gets the usual graceful stop (`drainMs`, `delayMs`). New workers run whatever the entry file and its imports are on disk when they start, which is how a deploy picks up new code without dropping the port. It resolves once the last old worker has exited.

If a new worker does not start within `startTimeoutMs` (default 30 s), the restart stops there and rejects: workers not yet replaced keep serving, and the ones already replaced stay replaced. `stop()` during a restart ends it. A second call while one is under way returns the first.

On Linux, closing a worker's listening socket resets the connections that were still being accepted on it, so a client can see a reset on a connection it opened in that instant. It is a small fraction of new connections and it scales with the connection rate. A client that retries an idempotent request once, as any client behind a load balancer does, does not notice: in testing, a second attempt never failed. On macOS no request failed. Setting `net.ipv4.tcp_migrate_req=1` makes the kernel hand those connections to the other workers, which reduced the resets in testing but also left some requests stalled until the client timed out, so it is not recommended with this engine.

`port` must be fixed: workers cannot share an ephemeral one. Windows has no `SO_REUSEPORT` and is refused. The Linux kernel balances accepts across the workers; macOS and BSD accept the shared bind but send new connections to one worker, so use it there for development only.

## Differences from `@nifrajs/node`

- No `static` or `fastResponse` options.
- Request bodies are buffered, up to `maxBodySize` plus `oversizeWindow`; a body past the window gets the engine's empty 413 rather than the app's own error.
- The peer's WebSocket close reason is not reported.
- WebSockets and HTTP/2 do not combine.

## Benchmark

`bench/compare.mjs` runs a rotated, serial `wrk` comparison on one Linux box, in two tiers:

- **Frameworks**, each answering the same three routes as an ordinary app: nifra on the Rust engine (`nifra-engine`, and `nifra-engine-host` with `validateHost`), on `@nifrajs/node-uws` (`nifra-uws`) and on `node:http` (`nifra-node`), and the Moro framework (`moro`). Workloads are a path-parameter GET, the same with a browser-sized header set, and 13 B and 1 KiB JSON POSTs with validation.
- **Raw engines**, each driven directly by one shared handler (`bench/raw-handler.mjs`) with no router, hooks or content-type check, so every engine does the same work for the same bytes: `raw-nifra-engine` (the addon on its batch ABI), `raw-uws`, `raw-node` and `raw-moro-engine` (`@morojs/engine`).

The first table reports median req/s, spread, and each row's ratio to `moro` and to `nifra-uws`. The second divides each framework by its own raw engine, which is that framework's layer cost; comparing raw engines to each other is the engine gap. `nifra-engine#2` is an A/A control, so its gap to `nifra-engine` is noise. A framework row set against a raw row of another stack is not a like-for-like comparison.

Moro is a benchmark competitor only. No nifra package depends on it: `bench/moro` holds its own `package.json` and `package-lock.json` (outside the workspace), installed with `npm ci` and found through `MORO_DIR`.

```sh
npm ci --prefix packages/node-engine/bench/moro --ignore-scripts
ROOT="$PWD" MORO_DIR="$PWD/packages/node-engine/bench/moro" NIFRA_RUST_ENGINE_PATH=/path/to/nifra_napi.node node packages/node-engine/bench/compare.mjs
```

Numbers that are reported come from the `Engine compare` workflow (manual dispatch), not from a developer machine. Configuration is environment: `ROUNDS`, `DURATION`, `TARGETS`, `WORKLOADS`, `OUT`.
