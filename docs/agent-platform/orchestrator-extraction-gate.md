# Future orchestrator extraction gate

The orchestration implementation remains at `@nifrajs/coding-agent/orchestration`. No
`@nifrajs/orchestrator` package is created by this program.

Extraction may be proposed only after both conditions are proven in a recorded decision:

1. A second production consumer outside `@nifrajs/coding-agent` uses the compiler, catalog, and host
   contracts for real work. Tests, Workbench, examples, and speculative consumers do not count.
2. A dependency analysis shows that extraction removes an unwanted dependency or cycle and reduces
   coupling compared with the current subpath facade. The record must include current/proposed graphs,
   package size and cold-start effects, protocol ownership, migration steps, and proof that no second
   executor is introduced.

Current status: neither prerequisite is recorded as satisfied, so the subpath facade remains the
stable public seam. This is an intentional no-op decision, not a deferred package promise.
