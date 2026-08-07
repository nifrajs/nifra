# @nifrajs/image

Image optimization for nifra - a CLS-safe responsive <Image> + pluggable loaders (CDN or self-hosted) + pure-JS dimension reading. The zero-dependency core also includes safe, cacheable Open Graph SVG generation at `@nifrajs/image/og` - useful where you control the consumer, but no major crawler renders SVG for `og:image`, so a social card needs an injected PNG/JPEG rasterizer. The optional Bun.Image-backed resize endpoint lives at `@nifrajs/image/server`.

Part of the **[nifra](https://nifra.dev)** full-stack TypeScript framework - one core, five UI libraries, every runtime. Scaffold a new app with `bun create nifra`.

## Install

```sh
bun add @nifrajs/image
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
