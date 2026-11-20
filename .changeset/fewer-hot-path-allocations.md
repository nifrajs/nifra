---
"@nifrajs/deno": patch
"@nifrajs/mcp": patch
"@nifrajs/middleware": patch
"@nifrajs/node": patch
"@nifrajs/proxy": patch
---

Request-path helpers reuse their text encoders, the proxy reads the forwarded protocol without parsing the URL again, response compression hands its buffer over without a copy, and an MCP HTTP reply is serialized once.
