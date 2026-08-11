---
"@nifrajs/cli": minor
---

The MCP server says when it is answering from a different nifra than the project builds with. A
client that launches a globally installed `nifra mcp` gets confident, authoritative answers about
types, checks, and docs from whichever CLI version happens to be on the machine - the mismatch is
invisible in every answer. The server now compares its own version against the `@nifrajs/cli` (or
`@nifrajs/core`) installed in the resolved project root, and when the feature versions differ it
stamps a warning naming both versions on the `initialize` instructions and on every project tool
result, with the command that runs the project's own CLI instead. Patch-level differences are not
reported.
