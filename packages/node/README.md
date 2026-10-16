# @nifrajs/node

Run a [nifra](../../README.md) app on Node's `http` server - nifra's ergonomics, deployed
on Node instead of Bun.

```sh
bun add @nifrajs/node   # or: npm add @nifrajs/node
```

```ts
import { server } from "@nifrajs/core/server"
import { serve } from "@nifrajs/node"

const app = server().get("/users/:id", (c) => ({ id: c.params.id }))

const node = await serve(app, { port: 3000 })
// node.port            → the bound port (resolved; useful with `port: 0`)
// await node.stop()    → drain in-flight, then force-close (graceful shutdown)
```

`serve(app, { port })` bridges Node's stream-based `(req, res)` to/from the Web
`Request`/`Response` that `app.fetch` speaks - that's the only Bun-specific seam, since
nifra's lifecycle is already Web-standard. It also gives you a graceful `stop()`, the
Node equivalent of Bun's `app.listen()`.

## Public URL protocol

The adapter creates a plain Node `http` server, so `Request.url` uses `http://` by
default. If TLS terminates in front of Node, set the public protocol explicitly:

```ts
await serve(app, { port: 3000, protocol: "https" })
```

Forwarded protocol headers are not trusted automatically; pass a function only when your
own trusted infrastructure has validated the request:

```ts
await serve(app, {
  port: 3000,
  protocol: (req) => req.headers["x-forwarded-proto"] === "https" ? "https" : "http",
})
```

By default, `request.url` reflects the inbound `Host` header. Do not use that value for
security decisions unless the deployment validates it. Set `allowedHosts` to reject unknown
host authorities, or set `canonicalHost` behind a trusted proxy to build URLs from a fixed
authority. If neither option is set, treat the host in `request.url` as client-controlled.

## Static files

The optional `static` root is served before `app.fetch` for GET and HEAD requests. It is a
public asset directory and must contain nothing private: no secrets, source maps, build
metadata, or user uploads. The directory and its ancestor path must be read-only and owned by
the service (or otherwise protected from untrusted local writers). Nifra resolves and confines
the file before opening it, and refuses it when its final file or any directory on its path became
a symlink in the meantime: on macOS the open itself refuses such a path, and on Linux the opened
descriptor's path is checked. On Windows and other platforms no file API can open without following a
middle link, so a process that swaps a directory concurrently can still win a local TOCTOU race;
the check there only makes it need repeated swaps. Mutable or attacker-writable static trees are
therefore outside the adapter's guarantee on those platforms. Store user-controlled files outside the static root and serve them through
an application or object-storage path with its own validation policy.

Every file carries `Accept-Ranges: bytes` and a strong `ETag` from its content: 128 bits of its
SHA-256, the same for the same bytes on every instance and on `servePublicDir`. A replacement that
keeps a file's size and timestamps - `cp -p`, `rsync -a`, tar, a container image layer,
SOURCE_DATE_EPOCH, the Nix store - still changes its tag. The tag is remembered per file version
(device, inode, size, mtime and ctime), so a known file costs no extra read; the first request for a
file reads it once (a file up to 256 KiB is then served from those bytes), and one changed in the last
2 s is read again until its ctime settles. A file over 256 MiB is tagged by that identity instead of
its bytes: still strong, but different on each instance.

`Last-Modified` is sent only while the file's mtime is the time of its own last change (it matches its
ctime), since a copy that keeps or normalizes mtimes gives a changed file the old date. Explicit
validator headers still apply. `If-None-Match` takes precedence over `If-Modified-Since`; a matching
condition gets a bodyless 304. `Range` on GET is parsed by a copy of `@nifrajs/core/range`, the parser
`servePublicDir` uses, and gated by `If-Range`: it must name the file's strong tag, or its exact date
when the file has no strong tag. One range (overlapping or adjacent ones merge into one) gets 206, a
range-set that selects nothing gets 416, and several disjoint ranges get the whole file.

## Graceful shutdown on signals

Opt in to SIGTERM/SIGINT handling so a `docker stop` / Ctrl-C drains in-flight requests
before exit (mirrors Bun's `listen({ gracefulSignals })` - off by default, since owning
process signals should be a deliberate choice):

```ts
await serve(app, { port: 3000, signals: true })
```

In-flight requests get 10 s to finish before the stop forces them closed. Set the window to fit
the platform's kill grace period:

```ts
await serve(app, { port: 3000, signals: { drainMs: 8_000 } })
```

## What you get for free

The request timeout (`server({ requestTimeoutMs })` → `503 request_timeout`) and body-size
cap live **inside `app.fetch`**, not Bun's `listen()` - so they apply through this adapter
with no extra wiring. Slow-client / slow-loris protection is Node's built-in
`requestTimeout` (300s) and `headersTimeout` (60s) defaults.

A hook that throws past `app.fetch`, or a response Node refuses to write (a header value carrying
CR/LF, say), answers `500` and is logged through the app's own `logger`, as Bun's `listen()` logs it. The `req` a hook sees is a lazy stand-in for Node's request: copy it
with `req.clone()`, not `new Request(req)`, which Node's `Request` constructor refuses.

Works with any `{ fetch(req): Promise<Response> }` handler, not just nifra. ESM-only. MIT.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
