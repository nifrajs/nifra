# Private dispatch adapter handoff

The public run-dispatch seam is `RunDispatchStore` plus the optional
`DurableDispatchAdapter<OpaqueContext>` contract exported by
`@nifrajs/coding-agent/orchestration`. It carries only run and node identifiers, plan digests,
attempt counters, lease generations, idempotency keys, schedule tokens, timestamps, and stable
status codes.

An operated adapter may implement the seam outside the public repository. Its caller-owned opaque
context is responsible for:

- data-layer authorization before every enqueue, lease, inspection, and settlement;
- row-level policy enforcement at the data layer, never in a UI or log filter;
- durable queue and worker ownership with lease-generation compare-and-commit behavior;
- retention and deletion policy for evidence, handled outside the public reference adapter;
- reconciliation of abandoned or conflicting work;
- worker health and fleet admission; and
- separation of caller-owned artifacts from the evidence-only dispatch record.

The adapter must preserve at-least-once delivery semantics. It must not advertise exactly-once
delivery, infer that a side effect completed without an idempotency proof, or allow an older lease to
overwrite a newer generation or terminal state. Dead-letter records contain identifiers, attempts,
terminal codes, schedule tokens, timestamps, and digests only.

The public repository includes only disposable memory and fake conformance fixtures. It does not
describe a vendor, tenant schema, private topology, credential system, pricing, retention period,
or hosted fleet.
