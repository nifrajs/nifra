# @nifrajs/deploy-fly

Build-time Fly.io packaging for a Nifra app using the existing Node deployment target. It emits a
Dockerfile and `fly.toml`; it does not deploy, contact Fly.io, or manage credentials.

```sh
bun add @nifrajs/deploy-fly
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

Then build and deploy the emitted directory:

```sh
nifra build
cd dist
fly deploy
```

`app` is required. `primaryRegion`, `internalPort` (default `3000`), and `forceHttps` (default
`true`), and `healthCheckPath` are optional. Set `healthCheckPath` only when the app has a route that
returns 2xx while ready. The adapter emits Fly service-level checks for that path; without it, no
health endpoint is assumed. Put secrets in Fly secrets with `fly secrets set`; do not put them in
adapter options. Nifra scans emitted adapter files for credentials before publishing the output.

The adapter uses Nifra's Node target, so the built server and its static assets stay under Nifra's
normal build and portability checks. The adapter only adds deployment metadata. It supports ordinary
SSR; it currently declares no support for the coordinated component pipeline.

Adapters execute as trusted build-time code in the Nifra CLI process. Their API is versioned, their
output is declarative, and Nifra rejects unsafe paths, collisions, credential findings, and failed
builds before replacing the last successful deploy directory.
