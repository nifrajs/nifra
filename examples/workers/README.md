# nifra on Cloudflare Workers

A nifra backend deployed to the edge. `toFetchHandler(app)` (from `@nifrajs/core`) adapts the app to
the Workers `ExportedHandler` shape and threads the platform into the nifra context:

- **`c.env`** — Workers bindings (vars/KV/D1/secrets). Declare the shape with `server<Env>()` to read
  them **typed** (`c.env.KV`, no cast); `toFetchHandler`'s `env` argument is typed too.
- **`c.waitUntil(promise)`** — background work that outlives the response.

```ts
import { server, toFetchHandler } from "@nifrajs/core"
interface Env {
  readonly GREETING?: string
}
const app = server<Env>().get("/", (c) => ({ greeting: c.env.GREETING ?? "hello" })) // c.env: Env
export default toFetchHandler(app)
```

In a nifra **frontend** app, route loaders/actions read the same typed bindings via
`LoaderArgs<typeof app, Env>` (e.g. `async function loader({ env }: LoaderArgs<typeof backend, Env>)`)
— `createWebApp` forwards `c.env` to them.

```sh
bunx wrangler dev      # run locally on workerd
bunx wrangler deploy   # deploy
```

The same `app` is portable: `app.listen()` on Bun, `@nifrajs/node` on Node, `@nifrajs/deno` on Deno —
`app.fetch` is a pure Web-standard handler.

> Monorepo note: when running this from the nifra monorepo (where `@nifrajs/core` isn't installed into
> `node_modules`), point wrangler at the local build with an alias, e.g. add to `wrangler.toml`:
> `alias = { "@nifrajs/core" = "../../packages/core/dist/index.js" }` (run `bun run build` first). In a
> real project `@nifrajs/core` resolves from `node_modules` and no alias is needed.

## Frontend SSR on the edge

This example is a **backend**. For the **full file-routed frontend** (SSR + hydration + loaders +
actions + streaming + `defer()`) on Workers, see [`workers-ssr-react`](../workers-ssr-react/) and
[`workers-ssr-solid`](../workers-ssr-solid/). The three disk-less-edge problems are solved at build
time: the route manifest is pre-baked via `generateServerManifest` (static imports — no runtime
`node:fs`), `buildServer` bundles a self-contained worker with the renderer's **edge** build, and the
client assets are served by **Workers Assets**. `createWebApp` and both adapters are unchanged.
