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

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
