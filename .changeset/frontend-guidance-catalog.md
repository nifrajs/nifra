---
"@nifrajs/cli": minor
---

Add `nifra_frontend` (MCP) and `nifra frontend` (CLI): a symptom-indexed catalog of client-side
footguns across every adapter (React, Preact, Solid, Vue, Svelte, vanilla). Each entry returns the
cause, the concrete fix, and how to verify it. It splits along the seam `nifra_check` already owns: the
adapter-independent boundary issues (a server-only import leaking into a client component, a hydration
mismatch, a duplicated framework runtime, loader-data typing) point at the `nifra_*` tool that fixes
and checks them, while the per-framework reactivity-loss idioms (Vue ref, Solid props, Svelte runes,
React effect deps) point at that framework's own ESLint plugin rather than re-implementing it. Reach
for it when a rendered page misbehaves and the static check is green. The tool is project-independent,
so it is served on every transport (project stdio, `nifra docs-mcp`, and the site's `/mcp` worker), and
the per-framework `nifra_scaffold` notes now route to it.
