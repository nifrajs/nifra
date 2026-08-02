---
"@nifrajs/core": patch
---

Route precedence now has one home: a `sortRoutesBySpecificity` helper on `@nifrajs/core/pattern` orders compiled routes most-specific-first (a static segment beats a dynamic one). The web router, the mock server, and the editor plugin all order routes through it, so which file a path resolves to stays identical across runtime, client, and editor.
