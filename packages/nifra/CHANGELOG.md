# nifra

## 1.1.0

### Patch Changes

- @nifrajs/core@1.1.0

## 1.0.0

### Patch Changes

- Updated dependencies [f1f0e18]
- Updated dependencies [3efb7cd]
- Updated dependencies [de9675b]
  - @nifrajs/core@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/core@1.0.0-beta.4

## 1.0.0-beta.3

### Minor Changes

- 3da96bb: feat(mcp): monorepo-aware MCP server. Running `nifra mcp` from a workspace root whose `nifra.config.ts` exports `apps: Record<string, string>` (name → relative path) now auto-detects the monorepo and exposes every app's tools namespaced as `nifra_<name>_context`, `nifra_<name>_run`, etc. — one MCP server for the whole repo. Single-app projects are unchanged. Docs tools (`nifra_docs`, `nifra_example`) remain unnamespaced and shared.

  ```ts
  // nifra.config.ts (workspace root)
  export const apps = {
    dashboard: "./apps/dashboard",
    portal: "./apps/portal",
  };
  ```

### Patch Changes

- @nifrajs/core@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- @nifrajs/core@0.1.0-beta.2
