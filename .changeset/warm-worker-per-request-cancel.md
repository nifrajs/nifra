---
"@nifrajs/cli": patch
---

**MCP warm worker survives a single per-request cancel.** The warm `nifra_run`/`nifra_render` worker is shared across concurrent calls (its `pending` map is id-keyed so several requests can be outstanding at once). Cancelling one request used to kill the whole worker process, which rejected every other in-flight request and forced a cold rebuild — defeating the warm reuse + concurrency the tool is built for. A per-request cancel now drops only that request and leaves the worker hot; it's still replaced on file change as before.
