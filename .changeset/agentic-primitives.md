---
"@nifrajs/prompt": minor
"@nifrajs/mcp-db": minor
---

Two new agent-native packages. `@nifrajs/prompt`: type-safe prompts over any LLM provider — bind an instruction to input/output Standard Schemas, hand the output schema to the provider as its structured-output format, and get a validated, typed result (provider-neutral `complete` fn, markdown-fence tolerance, bounded `heal` retries). `@nifrajs/mcp-db`: serve a SQLite database as a fail-closed MCP server — allowlisted `list_tables`/`describe_table` by default; opt-in `run_query` requires an authorize hook and enforces read-only in layers (engine `PRAGMA query_only`, single-statement + SELECT-only gates, `EXPLAIN QUERY PLAN` allowlist verification, row/byte caps with truncation markers).
