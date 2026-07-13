# @nifrajs/mcp-db

## 1.10.0

### Patch Changes

- @nifrajs/mcp@1.10.0

## 1.9.1

### Patch Changes

- Updated dependencies [3eb27ae]
  - @nifrajs/mcp@1.9.1

## 1.9.0

### Patch Changes

- @nifrajs/mcp@1.9.0

## 1.8.0

### Patch Changes

- @nifrajs/mcp@1.8.0

## 1.7.0

### Patch Changes

- @nifrajs/mcp@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/mcp@1.6.0

## 1.5.0

### Minor Changes

- 79ac481: Two new agent-native packages. `@nifrajs/prompt`: type-safe prompts over any LLM provider — bind an instruction to input/output Standard Schemas, hand the output schema to the provider as its structured-output format, and get a validated, typed result (provider-neutral `complete` fn, markdown-fence tolerance, bounded `heal` retries). `@nifrajs/mcp-db`: serve a SQLite database as a fail-closed MCP server — allowlisted `list_tables`/`describe_table` by default; opt-in `run_query` requires an authorize hook and enforces read-only in layers (engine `PRAGMA query_only`, single-statement + SELECT-only gates, `EXPLAIN QUERY PLAN` allowlist verification, row/byte caps with truncation markers).

### Patch Changes

- @nifrajs/mcp@1.5.0
