---
"@nifrajs/cli": minor
---

`nifra mcp` resolves the project it describes instead of trusting the directory it was spawned in.
An MCP client configured with a different working directory used to get confident answers about
whatever happened to be there - or about no project at all - with nothing in the response saying so.

- `nifra mcp <dir>` takes an explicit project directory; a human-named root always wins.
- Without one, the spawn directory walks UP to the nearest nifra marker (a `package.json` depending
  on `@nifrajs/*`, or a `nifra.config.ts` monorepo root), so starting in a subdirectory still lands
  on the project.
- After the handshake the server reads the client's MCP `roots`. When the guess found no project, or
  found one disjoint from every workspace root, and exactly ONE workspace root is a nifra project,
  that root is adopted. Ambiguity adopts nothing.
- What cannot be resolved fails closed: project-scoped tools refuse with a remediation message that
  lists the candidate roots. When a root IS in effect, every project tool result carries a note
  naming it, and the `initialize` instructions announce it.
