---
"@nifrajs/mcp": minor
---

`bundleReactWidget` in `@nifrajs/mcp/react` returns a React widget's body at build time, so a server running on Node or Deno serves it through `defineMcpWidget({ html })` without calling `Bun.build`.
