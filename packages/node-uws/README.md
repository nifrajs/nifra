# @nifrajs/node-uws

Serve a [nifra](../../README.md) app on [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js)
from Node. It is `@nifrajs/node` with uWS's native HTTP server in place of `node:http`: requests reach
the app through the same node-direct lane, and answers are written with uWS's corked, copy-once API.

```ts
import { server } from "@nifrajs/core/server"
import { serve } from "@nifrajs/node-uws"

const app = server().get("/users/:id", (c) => ({ id: c.params.id }))

const handle = await serve(app, { port: 3000 })
// handle.port          the bound port (useful with `port: 0`)
// await handle.stop()  stop accepting, drain in-flight requests, close the rest
```

## Install

uWebSockets.js is not published to npm. Install it from GitHub, next to this package:

```sh
npm install uNetworking/uWebSockets.js#v20.71.0
```

Its releases ship prebuilt binaries for Node 22, 24 and 26 on macOS and Linux (x64, arm64) and Windows
(x64). There is none for Alpine (musl) or Windows on arm64, and a new Node major has none until upstream
publishes one. Importing this package fails with an error that says so when the addon cannot load.
Use `@nifrajs/node` where that matters.

## Options

| Option | |
|---|---|
| `port`, `hostname` | As in `@nifrajs/node`. |
| `protocol` | `"http"` or `"https"`: the scheme `Request.url` carries. `"https"` by default when `tls` is set. |
| `tls` | `{ keyFileName, certFileName, passphrase?, caFileName?, dhParamsFileName?, sslCiphers?, sslPreferLowMemoryUsage? }`. uWS reads the files itself, so these are paths, not PEM text. |
| `allowedHosts`, `canonicalHost`, `normalizeTarget` | Same rules and defaults as `@nifrajs/node`. |
| `gracefulSignals` | Call `stop()` on SIGTERM/SIGINT. Off by default. |

`static` and `fastResponse` are refused with a `TypeError`: serve files from a route or a static host in
front.

`stop({ drainMs, delayMs })`, `await using`, and the app's `onStopping` / `onStop` hooks behave as they
do on `@nifrajs/node`.

## How it differs from `@nifrajs/node`

- **No WebSockets.** A handshake is refused with `501`. Use `@nifrajs/node` for apps with `ws` routes.
- **Streaming responses** (SSE, streamed SSR) are written chunked with back-pressure; a body whose
  `Content-Length` is declared is sent with that length and cut off, not finished, if the stream ends
  short or runs long.
- **Headers uWS frames itself** - `Content-Length`, `Transfer-Encoding` and `Date` - are dropped from the
  app's response, and uWS adds a `uWebSockets: 20` header it cannot be told to omit.
- **Header values are checked** for CR, LF and other control characters before anything is written, and
  a status outside 100-999 is refused: either is a `500`, reported through the app's logger.
- **uWS's parser, not Node's.** It rejects a repeated `Host`, a request carrying both `Content-Length`
  and `Transfer-Encoding`, and an absolute-form target with `400`, before the app sees them. Its idle
  timeout is fixed at 10 seconds, and there is no equivalent of Node's `requestTimeout`.
- **Request bodies are pushed by uWS**, not pulled. The socket is throttled once 1 MiB is buffered
  unread; a body larger than the route's cap is refused with `413` as on `@nifrajs/node`.
- **An empty header value reads as absent** through `c.header()`.

## Notes for contributors

The shared pieces - the outcome runtime, Host and target policy, lifecycle and error hooks - come from
`@nifrajs/node/transport`. uWS objects are valid only while their callback runs, so the request copies
its headers out the moment an app goes asynchronous, and a response is never touched after it ended or
aborted: uWS throws on that, and an uncaught throw there ends the process.

Tests run on Node (`bun run test:node`), because uWS does not load under Bun.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
