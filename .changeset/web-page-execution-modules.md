---
"@nifrajs/web": patch
---

Page request execution is split from one 2,000-line closure into modules under `internal/`: shared setup, layout and middleware running, status and error pages, document assembly, and the action handler. Each is built once when the app starts, so no work moves onto a request. The package's exports and behaviour are unchanged.
