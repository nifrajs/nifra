---
"@nifrajs/cli": patch
---

The release verification runner, started as a script (`bun packages/cli/src/release-verification.ts`, which the nifra repository's `bun run verify` and `bun run check:release` use), now fails a gate whose `package.json` script is missing and skips the gates after it, with the missing script named in the fix. Before, the gate was reported as `undeclared` and the run still passed, so renaming a script silently dropped its gate from the release check. `nifra verify` and the `nifra_verify` MCP tool keep reporting such a gate as `undeclared` for a project that does not declare the nifra repository's scripts.
