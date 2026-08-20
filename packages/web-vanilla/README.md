# @nifrajs/web-vanilla

Zero-framework render adapter for @nifrajs/web - auto-escaping tagged-template HTML, ~0 KB client JS, interactivity via @nifrajs/web/islands.

Part of the **[nifra](https://nifra.dev)** full-stack TypeScript framework - one core, five UI libraries, every runtime. Scaffold a new app with `bun create nifra`.

## The AI-safe lane

Vanilla is the render adapter an agent gets right on the first try. It ships no framework runtime, so there is no hydration, no reactivity, and none of the failure modes (stale closures, hydration mismatch, what-re-runs-when) that trip up generated code. You get true SSR plus every server feature - loaders, actions, ISR/SSG, streaming, head management - unchanged from `@nifrajs/web`; those live in the core, not the view layer.

Interactivity is added with **islands**, not hydration: small imperative DOM enhancers over server-rendered elements. `defineIsland` types the props, `createIslandBus` coordinates islands over a typed channel, and every enhancer returns its cleanup - the one rule `nifra check` enforces (`NF-C020`). See the [islands cookbook](https://nifra.dev/docs/islands) for the counter, cart-badge, and filter patterns, or run `nifra scaffold` on a vanilla route for the golden stub.

Need a stateful app UI with reactive components? That is what the five framework adapters are for - reach for `@nifrajs/web-preact` or `@nifrajs/web-solid` when you want a small reactive runtime.

## Install

```sh
bun add @nifrajs/web-vanilla
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
