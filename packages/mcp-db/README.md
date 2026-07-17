# @nifrajs/mcp-db

Expose an allowlisted SQLite schema as a fail-closed MCP server, with opt-in read-only queries.

```sh
bun add @nifrajs/mcp-db
```

```ts
import { Database } from "bun:sqlite"
import { serveDatabaseAsMcp } from "@nifrajs/mcp-db"

const mcp = serveDatabaseAsMcp(new Database("app.db"), {
  tables: ["habits", "entries"],
})
```

Only `list_tables` and `describe_table` are exposed by default, restricted to the explicit table
allowlist. `run_query` requires an authorization hook and is guarded by SQLite query-only mode,
single-statement/read-only checks, query-plan verification, and bounded output. D1 is not supported
because it cannot provide the same engine-level read-only guarantee.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
