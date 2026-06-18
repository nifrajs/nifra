# create-nifra

Scaffold a new [nifra](../../README.md) app.

```sh
bun create nifra my-app
# or:  npm create nifra my-app
```

## Templates

`--template <name>` (default `api`):

- **`api`** — a typed nifra server (`src/app.ts` + `src/index.ts`) with an example test and
  `dev`/`start`/`test`/`typecheck` scripts.
- **`site`** — a nifra + React SSR site, one source deployable to Cloudflare Pages, Node, Deno, or
  Vercel Edge.
- **`isr`** — a nifra + React app with **Incremental Static Regeneration** on Cloudflare Workers + KV
  (pages cached + served stale-while-revalidate; on-demand purge endpoint).

```sh
bun create nifra my-app --template isr
```

Then:

```sh
cd my-app
bun install
bun run dev
```

MIT.
