---
"@nifrajs/core": patch
---

Preserve authenticated-request metadata when stripping mount prefixes, including WebSocket-to-HTTP request reuse, so child response caches cannot share custom-credential responses across users. Keep mount authentication refusals terminal even when their status is 404 and child-miss fallthrough is enabled, for both HTTP and WebSockets.
