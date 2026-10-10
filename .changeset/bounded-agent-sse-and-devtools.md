---
"@nifrajs/ag-ui": patch
"@nifrajs/agent-app": patch
"@nifrajs/devtools": patch
---

Detach AG-UI viewers on initial or later output overflow, cancel unlogged work, and preserve logged run results for replay. Parse fragmented agent SSE frames with linear scanning and UTF-8 accounting. Bound each DevTools connection's pending bytes and close stalled readers, replaying only the recent history that fits.
