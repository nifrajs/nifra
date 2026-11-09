# @nifrajs/deploy-fly

Build-time Fly.io packaging for a Nifra app using the existing Node deployment target. It emits a
Dockerfile and `fly.toml`; it does not deploy, contact Fly.io, or manage credentials.

```sh
bun add @nifrajs/deploy-fly @nifrajs/node
```

```ts
// backend/framework.ts: runtime-only exports imported by the generated server.
import { reactAdapter } from "@nifrajs/web-react"
export const adapter = reactAdapter
export const clientModule = "@nifrajs/web-react/client"
```

```ts
// nifra.config.ts: CLI-only deployment configuration.
import { flyAdapter } from "@nifrajs/deploy-fly"
export { adapter, clientModule } from "./backend/framework.ts"

export const target = "fly"
export const deploymentAdapter = {
  adapter: flyAdapter,
  options: { app: "my-nifra-app", primaryRegion: "iad" },
}
```

Create the Fly app once before its first deploy if it does not already exist, then build and deploy
the emitted directory:

```sh
fly apps create my-nifra-app
nifra build
cd dist
fly deploy
```

`app` is required. `primaryRegion`, `internalPort` (default `3000`), `forceHttps` (default `true`),
`healthCheckPath`, and `image` (default `node:22-slim`) are optional. Pin `image` to an exact tag or
a `node@sha256:<digest>` reference for reproducible images. Set `healthCheckPath` only when the app has a route that
returns 2xx while ready. The adapter emits Fly service-level checks for that path; without it, no
health endpoint is assumed. Put secrets in Fly secrets with `fly secrets set`; do not put them in
adapter options. Nifra scans emitted adapter files for credentials before publishing the output.

The adapter uses Nifra's Node target, so the built server and its static assets stay under Nifra's
normal build and portability checks. The adapter only adds deployment metadata. It supports ordinary
SSR; it currently declares no support for the coordinated component pipeline.

The emitted Dockerfile sets `NODE_ENV=production`, and production refuses in-memory stores. An app
that uses one (the site scaffold's rate limiter, for example) must configure a shared store or, for
a single machine, allow it explicitly: the scaffold reads `NIFRA_ALLOW_MEMORY_RATE_LIMIT=true`, set
with `fly secrets set`. An in-memory limiter keeps one quota per machine and `fly deploy` adds a
spare machine by default, so deploy with `fly deploy --ha=false` and confirm one machine with
`fly status`, or use a shared store. Behind Fly's proxy the socket peer is the proxy, so visitors
that share a peer share one bucket and get 429 once it is spent. To key it per visitor, declare
`clientIp: { header: "fly-client-ip" }` on the server, and only when the app is reachable
exclusively through Fly's proxy.

Adapters execute as trusted build-time code in the Nifra CLI process. Their API is versioned, their
output is declarative, and Nifra rejects unsafe paths, collisions, credential findings, and failed
builds before replacing the last successful deploy directory.

For agent-oriented package guidance, see [`LLM.md`](./LLM.md) and the full
[`llms-full.txt`](../../llms-full.txt) corpus.
