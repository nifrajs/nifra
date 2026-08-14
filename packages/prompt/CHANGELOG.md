# @nifrajs/prompt

## 2.14.1

### Patch Changes

- Updated dependencies [bf93902]
  - @nifrajs/core@2.14.1

## 2.14.0

### Patch Changes

- Updated dependencies [701961a]
- Updated dependencies [62133bf]
- Updated dependencies [8dffdf4]
  - @nifrajs/core@2.14.0

## 2.13.0

### Patch Changes

- Updated dependencies [e0b2dd6]
- Updated dependencies [7535ce1]
- Updated dependencies [1704308]
  - @nifrajs/core@2.13.0

## 2.12.1

### Patch Changes

- Updated dependencies [fba30c7]
  - @nifrajs/core@2.12.1

## 2.12.0

### Patch Changes

- Updated dependencies [df100d3]
- Updated dependencies [0efacea]
- Updated dependencies [cd1732c]
- Updated dependencies [df100d3]
- Updated dependencies [9a9346e]
- Updated dependencies [b5f47c0]
- Updated dependencies [fc33c0f]
- Updated dependencies [c4e8bb0]
- Updated dependencies [11d1658]
- Updated dependencies [5f71c23]
- Updated dependencies [3788b36]
- Updated dependencies [ae5338f]
- Updated dependencies [8847825]
- Updated dependencies [9a9346e]
- Updated dependencies [5e4e31a]
- Updated dependencies [9a9346e]
- Updated dependencies [b045f9e]
- Updated dependencies [9a9346e]
- Updated dependencies [9a9346e]
- Updated dependencies [dbc0b79]
- Updated dependencies [bd5c624]
- Updated dependencies [a5d3f5b]
- Updated dependencies [00819c5]
- Updated dependencies [e2bdd4a]
- Updated dependencies [e2d1939]
- Updated dependencies [e83e6eb]
- Updated dependencies [f8b0097]
  - @nifrajs/core@2.12.0

## 2.11.0

### Patch Changes

- @nifrajs/core@2.11.0

## 2.10.0

### Patch Changes

- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
  - @nifrajs/core@2.10.0

## 2.9.1

### Patch Changes

- Updated dependencies [01e36fb]
  - @nifrajs/core@2.9.1

## 2.9.0

### Patch Changes

- Updated dependencies [e05e56d]
  - @nifrajs/core@2.9.0

## 2.8.2

### Patch Changes

- Updated dependencies [f7d68e8]
  - @nifrajs/core@2.8.2

## 2.8.1

### Patch Changes

- Updated dependencies [78d66a4]
- Updated dependencies [93fdc89]
  - @nifrajs/core@2.8.1

## 2.8.0

### Patch Changes

- @nifrajs/core@2.8.0

## 2.7.1

### Patch Changes

- Updated dependencies [52c89e0]
  - @nifrajs/core@2.7.1

## 2.7.0

### Patch Changes

- @nifrajs/core@2.7.0

## 2.6.1

### Patch Changes

- Updated dependencies [5840c98]
  - @nifrajs/core@2.6.1

## 2.6.0

### Patch Changes

- Updated dependencies [e6349e5]
  - @nifrajs/core@2.6.0

## 2.5.0

### Patch Changes

- @nifrajs/core@2.5.0

## 2.4.0

### Patch Changes

- Updated dependencies [138bfba]
  - @nifrajs/core@2.4.0

## 2.3.0

### Patch Changes

- Updated dependencies [6f5b3ad]
- Updated dependencies [85b354d]
- Updated dependencies [8514caa]
- Updated dependencies [ea0a27f]
- Updated dependencies [ea0a27f]
- Updated dependencies [b271164]
- Updated dependencies [8c77d47]
- Updated dependencies [ea0a27f]
- Updated dependencies [5fe332a]
- Updated dependencies [d2840ac]
  - @nifrajs/core@2.3.0

## 2.2.0

### Patch Changes

- Updated dependencies [5f460db]
- Updated dependencies [e713cab]
- Updated dependencies [a4645e2]
- Updated dependencies [6aa0aac]
  - @nifrajs/core@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [bd294bb]
- Updated dependencies [d3aac63]
  - @nifrajs/core@2.1.0

## 2.0.0

### Patch Changes

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.
- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0

## 1.13.0

### Patch Changes

- Updated dependencies [aae8614]
- Updated dependencies [5b6127a]
  - @nifrajs/core@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [63d3845]
- Updated dependencies [246f498]
  - @nifrajs/core@1.12.0

## 1.11.0

### Patch Changes

- Updated dependencies [2dde7e5]
- Updated dependencies [279f80c]
- Updated dependencies [5638ada]
- Updated dependencies [279f80c]
  - @nifrajs/core@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [92181be]
- Updated dependencies [3773f0a]
- Updated dependencies [92181be]
  - @nifrajs/core@1.10.0

## 1.9.1

### Patch Changes

- @nifrajs/core@1.9.1

## 1.9.0

### Patch Changes

- Updated dependencies [03cd76f]
- Updated dependencies [03cd76f]
  - @nifrajs/core@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies [e47c4c5]
  - @nifrajs/core@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies [bd95181]
  - @nifrajs/core@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/core@1.6.0

## 1.5.0

### Minor Changes

- 79ac481: Two new agent-native packages. `@nifrajs/prompt`: type-safe prompts over any LLM provider - bind an instruction to input/output Standard Schemas, hand the output schema to the provider as its structured-output format, and get a validated, typed result (provider-neutral `complete` fn, markdown-fence tolerance, bounded `heal` retries). `@nifrajs/mcp-db`: serve a SQLite database as a fail-closed MCP server - allowlisted `list_tables`/`describe_table` by default; opt-in `run_query` requires an authorize hook and enforces read-only in layers (engine `PRAGMA query_only`, single-statement + SELECT-only gates, `EXPLAIN QUERY PLAN` allowlist verification, row/byte caps with truncation markers).

### Patch Changes

- Updated dependencies [1ac2fde]
- Updated dependencies [bd3433f]
- Updated dependencies [70aa836]
  - @nifrajs/core@1.5.0
