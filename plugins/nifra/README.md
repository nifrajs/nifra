# Nifra OpenAI plugin

This package connects ChatGPT and Codex to Nifra's public, stateless, read-only documentation MCP.

It exposes:

- `nifra_docs` - search Nifra documentation.
- `nifra_example` - return verified copy-pasteable examples.
- `nifra_types` - look up exact generated TypeScript declarations.
- `nifra_learn` - follow the ordered Nifra learning path.
- `nifra_frontend` - diagnose common frontend issues.

The plugin has no project, filesystem, repository, deployment, or secret access.

## Endpoint

The OpenAI surface uses `https://mcp.nifra.dev/openai`. It is a text-only surface over the same
public documentation corpus as Nifra's regular docs MCP; the interactive example gallery is not
exposed on this route.

## Local verification

From the repository root:

```sh
bun run check:openai-plugin
bun test packages/cli/test/mcp-http.test.ts
```
