# @nifrajs/web

Framework-agnostic SSR core for nifra - the render seam + HTML document orchestration.

Part of the **[nifra](https://nifra.dev)** full-stack TypeScript framework - one core, five UI libraries, every runtime. Scaffold a new app with `bun create nifra`.

One package, the same on React, Preact, Vue, Solid and Svelte (pick the renderer with a
`@nifrajs/web-*` adapter):

- File routing, nested layouts, typed loaders and actions, progressive-enhancement forms, and the
  client router with prefetch and scroll restoration - [routing](https://nifra.dev/docs/routing),
  [loaders & actions](https://nifra.dev/docs/data).
- Streaming SSR with `defer()`, SSG, and ISR with tag purges - [rendering](https://nifra.dev/docs/rendering).
- [Live refresh](https://nifra.dev/docs/live) (`@nifrajs/web/live`, `/live-client`, `/live-redis`):
  loaders declare keys, a publish reloads only what read them.
- [Partial prerendering](https://nifra.dev/docs/partial-prerendering) (`@nifrajs/web/ppr`): a cached
  shell, with per-visitor holes streamed in.
- [Keep-alive](https://nifra.dev/docs/keep-alive) pages, a query cache, optimistic fetchers, and
  [islands](https://nifra.dev/docs/islands) (`@nifrajs/web/islands`) for pages with no framework runtime.
- Optional [server components](https://nifra.dev/docs/server-components) on all five adapters:
  React uses native RSC/Flight, the others their own islands in validated server-rendered ranges.
  Definitions take closed input and public-props schemas and authorization; a refresh runs the
  owner page's GET with its admission, capabilities, budgets and cancellation. Use the
  `/server-components`, `/server-components/client`, `/server-components/islands` and
  `/server-components/build` exports with a `componentPipeline` config export; the repository has a
  runnable example per adapter.

## Guarding pages

A `_layout.backend.ts` loader is data, not a guard: a client navigation can skip it while the browser
keeps the layout's data, and an action below it runs without it. Refuse access in that file's
`middleware`, or export `gate = true` so its loader runs on every request and before every action,
ahead of the page loader. In development, nifra warns when a layout loader without `gate` refuses a
request, and `nifra check` reports one whose refusal it can read (NF-C042). See [Layout loaders on navigation](https://nifra.dev/docs/data).

## Install

```sh
bun add @nifrajs/web
```

## Docs

- Reference: <https://nifra.dev/docs>
- AI-readable: <https://nifra.dev/llms.txt>

MIT

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
