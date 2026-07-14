---
"@nifrajs/core": minor
"@nifrajs/cli": minor
---

Add the effect ledger, sandboxed contract-generated invariant tests, and the verification ladder.

**Effect ledger** — a per-request, append-only, ordered record of side-effect intents and outcomes.
Routes that declare `schema.capabilities` get a bounded, token-only ledger when the server enables
`server({ effectLedger })`; each `useCapability(c, id, { target, cost, digest })` beacon
records an intent, `recordCapabilityOutcome` records its terminal result without double-debiting
admission, and the sink receives the sealed ledger when the response settles — on success and
error responses alike, so partial work is audited. Entries carry capability ids, phases, adapter
tokens, dimensionless cost counters, an optional keyed-HMAC payload digest, and bounded error codes;
the entry type has no payload field, and the sealed ledger names the route *pattern* plus the declared
capability set, never the concrete URL — redaction holds by construction. Includes an optional
tamper-evident hash chain, a bounded in-memory sink,
and `computeEffectDigest` (keyed HMAC-SHA-256, so low-entropy data cannot be brute-forced from a
stored digest). The hash chain binds route identity, declarations, timestamps, and entries. Sink
failures are logged without their potentially-sensitive message and do not turn a successful effect
into a retryable 500; transactional audit belongs in the effect's owning transaction. Routes without
capability declarations keep the existing fast path unchanged.

**Contract-generated invariant tests** — `runContractInvariants(app, { executor })` fuzzes each route from its
declared JSON Schema with a deterministic seeded generator and verifies what the contract promises:
valid inputs never crash, 2xx responses conform to the declared response schema, schema-violating
bodies are rejected (never accepted, never a crash), and a route-level classification never
understates its field-level tags. Findings carry the case seed for exact reproduction; ungeneratable
routes are reported as skipped, never silently dropped.
Dynamic execution requires an explicit `invariants.executor` backed by a disposable app/sandbox;
verification never invokes a live app implicitly, and any skipped route prevents L4.

**Verification ladder** — `nifra levels` computes L0 typed contract → L1 route assurance → L2
capability lockfile → L3 route manifest → L4 invariant-tested from the existing gates. Levels are
cumulative and computed, never self-declared; `--min <n>` gates CI on a required floor.
