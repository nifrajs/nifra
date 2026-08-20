# @nifrajs/proxy

Reverse proxy for nifra - stream requests to one fixed upstream origin with hop-by-hop hygiene, SSRF-proof by construction. Dependency-free.

Part of the **[nifra](https://nifra.dev)** full-stack TypeScript framework - one core, five UI libraries, every runtime. Scaffold a new app with `bun create nifra`.

## Install

```sh
bun add @nifrajs/proxy
```

## Use

```ts
import { server } from "@nifrajs/core"
import { createProxy } from "@nifrajs/proxy"

const upstream = createProxy({ upstream: "http://127.0.0.1:8081" })
const app = server().mountFetch("/api", upstream, { stripPrefix: true })
```

The upstream is a **bare origin** fixed at construction - the forwarded URL is built by mutating a clone of that origin, never by resolving request-derived strings, so no request input can change which host is dialed. Hop-by-hop and `Connection`-nominated headers are stripped in both directions. Caller IP/protocol metadata is dropped unless `forwardClientIp: true`; the inbound Host is never trusted, and `X-Forwarded-Host` is emitted only from a fixed `forwardedHost`. Upstream redirects are never followed, and TLS verification has no off switch. Unreachable upstreams answer a flat `502`; the deadline (`timeoutMs`, default 30s) answers `504`.

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
