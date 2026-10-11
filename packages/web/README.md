# @nifrajs/web

Optional server components are implemented for React, Vue, Svelte and Solid in the post-4.0
feature branch. React uses native RSC/Flight; the other adapters use native islands in validated
server ranges. Definitions require closed input/public-props schemas and authorization. Refresh
executes the actual owner GET, preserving admission, read capabilities, budgets and cancellation;
output is private/no-store. Mutate through validated server functions or actions.

Use the `/server-components`, `/server-components/client`, `/server-components/islands` and
`/server-components/build` exports with an explicit `componentPipeline` named config export.
See [the server-components guide](https://nifra.dev/docs/server-components) and the four runnable
repository examples for complete entries, native outlets, exact compiler pins and rollback.

Framework-agnostic SSR core for nifra - the render seam + HTML document orchestration.

Part of the **[nifra](https://nifra.dev)** full-stack TypeScript framework - one core, five UI libraries, every runtime. Scaffold a new app with `bun create nifra`.

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
