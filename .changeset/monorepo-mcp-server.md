---
"nifra": minor
---

feat(mcp): monorepo-aware MCP server. Running `nifra mcp` from a workspace root whose `nifra.config.ts` exports `apps: Record<string, string>` (name → relative path) now auto-detects the monorepo and exposes every app's tools namespaced as `nifra_<name>_context`, `nifra_<name>_run`, etc. — one MCP server for the whole repo. Single-app projects are unchanged. Docs tools (`nifra_docs`, `nifra_example`) remain unnamespaced and shared.

```ts
// nifra.config.ts (workspace root)
export const apps = {
  dashboard: "./apps/dashboard",
  portal:    "./apps/portal",
}
```
