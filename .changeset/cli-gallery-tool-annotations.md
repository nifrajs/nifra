---
"@nifrajs/cli": patch
---

fix(cli): the `nifra_gallery` MCP tool declares itself non-destructive and idempotent in its
annotations, so clients that gate tool calls on those hints run it without asking.
