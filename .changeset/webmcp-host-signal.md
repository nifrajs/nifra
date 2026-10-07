---
"@nifrajs/webmcp": minor
---

A WebMCP tool's `execute(input, context)` forwards `context.signal` into the capability, so a host cancellation reaches the executor's `ctx.signal`, and a call the host already cancelled never runs. `WebMcpExecuteContext` types that second argument.
