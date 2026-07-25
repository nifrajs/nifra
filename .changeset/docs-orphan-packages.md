---
"@nifrajs/cli": patch
---

Documents seven packages that shipped without a single reference.

`web-vanilla` (zero-framework adapter) joins the frameworks page and gains `examples/web-vanilla`;
`devtools` joins dev; `mock` joins testing; `events` joins backends; `prompt`, `agent-telemetry` and
`mcp-db` join the coding-agents page.

All were real - 185 to 381 lines each, 9 to 23 tests each - and none were findable. Every added sample
is compiled by the docs gate against the live API.
