---
"@nifrajs/cli": patch
---

`nifra check` picks up a TypeScript install that lands while a long-lived process is running, and refuses a "typescript" that is not the compiler.

The rule that parses source with the project's TypeScript resolved it through a resolver that memoizes a specifier for the life of the process and, when the project has none installed, falls back to the global download cache. In a long-lived process - the MCP server - the first lookup before `bun install` pinned that cache entry, so every later check in the same session kept using it: the typecheck went phantom until the server was restarted. Resolution is now a filesystem probe for `node_modules/typescript` from the project root upward, the same walk the typecheck gate uses to find `tsc`, so an install that lands mid-session is seen on the next run.

The cache entry it resolved to was also not a compiler, only a version stub, which crashed the scan with `undefined is not an object (evaluating 'ts.ScriptKind.TSX')` - a Nifra-looking stack trace for "no compiler is installed here". A module that does not expose the compiler API is now treated as a resolution miss, so the CLI falls back to its own copy or reports TypeScript as missing.
