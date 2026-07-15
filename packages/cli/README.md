# @nifrajs/cli

The `nifra` CLI — zero-config dev/build/start for a nifra app, plus the agent surfaces (`nifra context`,
`nifra mcp`). Run from your project root (it reads `nifra.config.ts`/`framework.ts`, `backend.ts`, and
`routes/`).

```
nifra dev     [--port <n>] [--poll]       True-HMR dev server (Vite + nifra SSR).
nifra build   [--out <dir>]               Content-hashed client bundle + manifest.json.
nifra start   [--port <n>] [--out <dir>]  Serve the built app (client + SSR) on Bun.
nifra context                             Print this project's API + page routes + conventions.
nifra mcp                                 MCP server (stdio) exposing this project to a coding agent.
nifra check   [--json]                    Gate: typecheck + lints; --json includes fixes/suggestions.
nifra assure  [--config <file>] [--json]  Gate reflected routes against enforcement evidence.
nifra capabilities check [--json]        Gate effect provenance + the reviewed capability lockfile.
nifra manifest emit [--sign <key-ref>]   Emit the hash-verified route trust artifact after assurance.
nifra manifest diff <before> <after>      Block promotion on contract/governance regressions.
nifra doctor  [--json] [--auto-fix]       Catch undeclared imports and duplicate Nifra/React installs.
```

## `nifra doctor` - dependency health

Doctor diffs source imports against declared dependencies, then resolves identity-sensitive
dependencies from every workspace package. More than one physical `@nifrajs/*`, `react`, or
`react-dom` copy fails even when versions match; module identity is path-based. Doctor reports
paths/importers and never deletes installations.

## `nifra assure` — the route-enforcement gate

Create `nifra.assurance.ts` with a default `defineAssuranceConfig({ source, policy })` export, then run
`nifra assure` in CI. Official middleware publishes evidence at the same seam where it installs its
hooks; the gate classifies every reflected route with the first matching rule and exits non-zero for an
unclassified route, missing evidence, or forbidden evidence. Evaluation is startup/CI-only and adds no
request-path overhead. Use `--json` for the complete per-route report or `--config` for another file.

## `nifra manifest` — the deploy trust artifact

Add optional `manifest: { path, signer }` settings to `nifra.assurance.ts`, then run
`nifra manifest emit`. Emission refuses failing route or capability assurance and joins the route
schemas, enforcement evidence, effect tokens, and field-level response classification into one
deterministic SHA-256 artifact. `--sign <key-ref>` asks the configured callback to produce a detached
Ed25519 sidecar, so the private key can stay inside KMS/HSM infrastructure.

At promotion time, `nifra manifest diff previous.json candidate.json` hash-verifies both files and exits
non-zero on a breaking API change, removed assurance, expanded effect, lost provenance coverage, or
increased data sensitivity. This is separate from the frontend asset `dist/manifest.json`.

## `nifra check` — the drift gate (run as "done")

`nifra check` makes nifra's anti-drift guarantees actually fire instead of relying on the agent to
remember them. It does three things and exits non-zero if any fails:

1. **Typecheck** (`tsc --noEmit`, using the project's own TypeScript) — the frontend↔backend contract is
   compiler-enforced. `client<typeof app>` derives request inputs **and** `res.data` from your routes, so
   a screen that expects the wrong shape is a type error. Running the typecheck is what turns that latent
   guarantee into an enforced one.
2. **Typed-client lint** — flags any hand-rolled `fetch()` to your own API (a relative URL like
   `fetch("/users")`), which bypasses the typed client so the compiler can't see the drift. External
   absolute-URL fetches are not flagged.
3. **Server-only-import lint** — flags a top-level import of server-only code (a DB driver, `node:`/`bun:`
   builtins, the `./db` module) into a `routes/` page module. Those modules are bundled for the browser,
   so the import ships server code to the client. Reach it via `c.db` / `ctx.api` inside a loader instead.

Pass **`--json`** for a machine-readable result (`{ ok, typecheck, diagnostics[] }`) — what the
`nifra_check` MCP tool returns, so an agent acts on diagnostics instead of scraping output. Each diagnostic
has a short `fix` string and, when safe, a structured `suggestion`: an exact one-line diff, an argv command
array (for example `["bun","add","react"]`), or concrete manual steps. Tell a coding agent to run
`nifra check` as its definition of done (the scaffolded `AGENTS.md` already does), and wire it into CI — a
green check means the frontend and backend can't have silently diverged.

For hand-rolled own-API `fetch()` calls, `nifra check` stays conservative: simple string-literal calls
that match a statically visible Nifra route get an exact typed-client rewrite diff; dynamic URLs, custom
headers, bodies, query strings, or ambiguous routes fall back to manual steps.

## For AI coding agents

**`nifra context`** prints this project's actual surface — API routes (from `backend.routes()`), page
routes (from `routes/`), and the framework conventions — as Markdown. Pipe it into a prompt:

```sh
nifra context | pbcopy        # or: nifra context > .agent-context.md
```

**`nifra mcp`** runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, so
an agent can act on the project, not just read about it. Core tools:

- **`nifra_context`** — the same project surface as above.
- **`nifra_routes`** / **`nifra_openapi`** — structured API route contracts and an OpenAPI 3.1 document.
- **`nifra_docs`** / **`nifra_example`** — token-efficient docs slices and verified code snippets.
- **`nifra_scaffold`** — map a URL to the correct `routes/` file; optionally write safe JSX stubs.
- **`nifra_run`** — run HTTP requests through this project's backend and get structured results
  (status, headers, parsed body, and any thrown error). The backend is re-loaded in a fresh process
  each call by default, so it reflects the agent's latest edits — the write → run → see-the-failure
  → fix loop. Pass `warm:true` to reuse a hot worker while source files are unchanged.
- **`nifra_render`** — SSR a page route and return rendered HTML for quick page verification.
- **`nifra_ws`** — verify a WebSocket route with a real Bun WebSocket round-trip and structured output.
- **`nifra_test`** — run bounded `bun test` with structured output.
- **`nifra_check`** — run the drift gate and get the structured `{ ok, typecheck, diagnostics[] }`
  result with suggestions, so the agent verifies its own work and fixes each diagnostic before finishing.
- **`nifra_assure`** — evaluate `nifra.assurance.ts` and return the complete per-route evidence report.
- **`nifra_doctor`** — catch imported packages missing from `package.json`; with `autoFix:true`, write
  safe dependency entries when a version can be inferred locally and return exact `bun add` commands
  for anything that needs a package-manager decision.

The MCP server also exposes compact resources (`nifra://routes`, `nifra://openapi`, `nifra://package-json`,
`nifra://agents-md`) and prompt templates for common tasks.

For long-running stdio tool calls, nifra follows MCP's standard `_meta.progressToken` progress
notifications and `notifications/cancelled` request cancellation. `nifra_run`, `nifra_render`,
`nifra_test`, and full `nifra_check` calls stop their subprocess work when cancelled.
For token-sensitive clients, `tools/list` also accepts the opt-in extension `{ "compact": true }`;
call `tools/describe` with a tool name when you need the full schema and description.

Wire it into a client. Claude Desktop / Cursor (`mcp.json`):

```json
{
  "mcpServers": {
    "nifra": { "command": "nifra", "args": ["mcp"] }
  }
}
```

Claude Code:

```sh
claude mcp add nifra -- nifra mcp
```

Run the client from (or point it at) your project root. The protocol is hand-rolled
(newline-delimited JSON-RPC 2.0) — no SDK dependency.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
