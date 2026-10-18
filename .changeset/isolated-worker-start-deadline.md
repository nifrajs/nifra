---
"@nifrajs/coding-agent": patch
---

`IsolatedExtensionWorker.start()` now settles. A worker that exits before it reports ready, with status 0 as well as any other, rejects `start()` and every waiting call, and a worker that is not ready within the new `startTimeoutMs` option (default 30 s) is stopped and rejects them. Before, a clean early exit or an initializer that never settled left `start()` pending forever, since `timeoutMs` only bounds each tool call.
