---
"@nifrajs/web": patch
---

Page request execution is split from one 2,000-line closure into modules under `internal/`: shared setup, layout and middleware running, status and error pages, document assembly, and the action handler. Each is built once when the app starts, so no work moves onto a request. The package's exports are unchanged.

Three failures the split surfaced are fixed. A layout is no longer kept through a navigation that changed a param when the manifest does not say which params the layout owns. A gate that refuses a request no longer leaves a loader it did not wait for to fail unobserved. A layout whose `meta` throws no longer stops an error page or a status page from rendering; the page renders without the layouts.
