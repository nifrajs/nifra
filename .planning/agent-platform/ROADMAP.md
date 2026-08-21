# Nifra Agent Platform Roadmap

**Status:** Ready for phase planning and execution
**Program goal:** Turn the existing local coding-agent harness into a public, evidence-safe agent platform without duplicating its workflow engine or implementing private operated depth.
**Requirements:** 88, mapped once across 8 phases
**Architecture lock:** `RunPlan` compiles into the existing `WorkflowRunner`; orchestration remains `@nifrajs/coding-agent/orchestration` until the extraction gate in Phase 7 is satisfied.

## Dependency graph

```text
P0 Evidence-safe declarative tracer
 |
 +--> P1 Local orchestration plus eval feedback
 |     |
 |     +--> P3 Registry, policy, approval, handoff
 |     |      |
 |     |      +--> P4 Gateway plus deployment contracts
 |     |      |      |
 |     |      |      +--> P5 At-least-once jobs and recovery
 |     |      |             |
 |     |      |             +--> P6 Eval and observability studio
 |     |      |                    |
 |     +------+--------------------+--> P7 Compatibility and release hardening
 |
 +--> P2 Agent App SDK and Workbench cutover
       |
       +--> P3, P6, P7
```

**Critical path:** P0 -> P1 -> P3 -> P4 -> P5 -> P6 -> P7

P2 may execute in parallel with the later part of P1 after P0 lands. P3 waits for both P1 and P2 because its handoff lifecycle is orchestrated by the host and projected through the SDK. P6 waits for P5 so recovery evidence participates in evaluation and visualization. P7 waits for every prior phase.

## Phase 0: Evidence-safe declarative tracer

**Goal:** A production-quality single-node declarative run is parsed, compiled into the existing `WorkflowRunner`, executed through a fake registered step, projected into evidence, negotiated over protocol version 1, and accepted by a deterministic eval invariant.

**Requirements:** BND-01, BND-02, BND-03, BND-04, BND-05, BND-06, BND-07, BND-08, ORC-01, ORC-02, ORC-03, APS-01, EVL-01, EVL-02, QLT-01

**Dependencies:** Existing agent protocol, workflow runner, testing trajectory/failure lab, fake and replay backends, and package-boundary gates.

**Public deliverables:**

- Pure evidence and artifact-reference value contracts plus strict parsers.
- Serializable one-node `RunPlan`, graph validation, `StepCatalog`, and compiler in `coding-agent/orchestration`.
- One end-to-end tracer through `WorkflowRunner` with protocol feature negotiation and deterministic eval evidence.
- Frozen legacy protocol, replay, fake-backend, and `FileSessionStore` compatibility fixtures.
- Generic operated-depth implementation deny policy, declared disposable-reference allowlist, fail-closed CI marker configuration, and positive or negative boundary fixtures.

**Private seam handoff:** The phase defines only an `ArtifactPort` and operated-adapter boundaries. No private adapter is required to run the tracer.

**Observable exit criteria:**

1. A valid one-node plan executes and verifies end to end without Pi, provider credentials, a model call, or a second runner.
2. The same input and schedule produce the same terminal evidence digest in repeated runs.
3. Public reference serialization rejects every forbidden content field and every record larger than 4 KiB.
4. A legacy protocol version 1 client and fixture still decode with unchanged semantics.
5. Agent and public package-boundary checks pass with protected framework packages unchanged.
6. The generic boundary policy rejects operated implementation fixtures without marker configuration, CI rejects missing `PRIVATE_MARKERS`, and a configured sentinel marker is detected.

**Entry condition:** Current protocol, workflow, testing, replay, and boundary suites pass before changes; CI and release environments provide a non-empty `PRIVATE_MARKERS` secret while local generic-policy fixtures remain runnable without private names.

**Stop condition:** Stop if the tracer requires persisting closures, changing existing protocol field meaning, accepting raw payloads in evidence, or adding a new orchestration package. Correct the architecture before expansion.

**Reversibility:** Costly. New protocol fields are additive, but published evidence and plan contracts create compatibility obligations. Roll back by disabling negotiated features and retaining legacy decoders; do not rewrite version 1 semantics.

## Phase 1: Local orchestration and eval feedback

**Goal:** A local user can submit a bounded multi-node plan using every existing workflow primitive and receive deterministic terminal evidence plus an explicit eval comparison.

**Requirements:** ORC-04, ORC-05, ORC-06, ORC-07, ORC-08, ORC-09, ORC-10, EVL-03, EVL-04, EVL-05

**Dependencies:** Phase 0.

**Public deliverables:**

- Full declarative node compiler and versioned `StepCatalog`.
- `OrchestrationHost` lifecycle using `WorkflowRunner`, `BoundedSubagentRunner`, `ApprovalManager`, verification, and checkpoints.
- Evidence-only memory and local file adapters with bounded live windows.
- Eval suite, bounded rubric port, and baseline comparison composed with current testing primitives.

**Private seam handoff:** Scheduler, clock, run-record, and artifact ports are stable enough for private operated implementations, but no durable or tenant-aware implementation is built here.

**Observable exit criteria:**

1. A planner, two bounded parallel implementer steps, approval, verifier, and human-handoff fixture completes under declared ceilings.
2. Illegal lifecycle transitions, unknown steps, expanded child authority, and one-over-limit plans fail before unauthorized work.
3. Memory and file evidence adapters remain bounded and content-free across 100k generated events.
4. Eval comparison detects a seeded invariant or rubric regression and accepts equality or declared tolerance.
5. Source ownership checks prove no duplicate workflow, replay, approval, or subagent engine was introduced.

**Entry condition:** Phase 0 tracer and legacy compatibility fixtures pass.

**Stop condition:** Stop if a node cannot be represented declaratively without a content payload, if host policy can be overridden by a plan, or if orchestration behavior diverges from direct `WorkflowRunner` semantics.

**Reversibility:** Reversible behind negotiated feature flags and new module exports. Evidence format changes remain versioned and additive.

## Phase 2: Agent App SDK and Workbench cutover

**Goal:** CLI, Workbench, and an external consumer use one protocol-only SDK to submit and observe the same run across fake, replay, and local RPC backends.

**Requirements:** APS-02, APS-03, APS-04, APS-05, APS-06, APS-07, APS-08, APS-09, UX-01

**Dependencies:** Phase 0. Integration against the full orchestration lifecycle uses Phase 1, but SDK package creation and fake conformance may proceed in parallel with Phase 1.

**Public deliverables:**

- Additive protocol version 1 run, evidence, handoff, feature, and cursor contracts.
- New protocol-only `@nifrajs/agent-app` package with Web fetch and SSE transport, caller auth hook, command facade, reconnect logic, and safe view models.
- Workbench browser-client cutover through typed `apps/workbench/src/browser.ts`, a declared `@nifrajs/agent-app` workspace dependency, a browser bundle at `dist/public/app.js`, server delivery from `dist/public`, and fake or replay built-asset integration tests.
- Build, publish, and isolated-consumer plumbing for the one new public package.

**Private seam handoff:** Private clients may supply identity-aware authentication and routing hooks. The public SDK owns neither identity nor remote relay.

**Observable exit criteria:**

1. The same conformance suite passes against fake, replay, and local RPC without Pi or model access.
2. Duplicate, reordered, disconnected, and stale-cursor streams are either reconstructed in order or report an explicit resync requirement.
3. Workbench production browser code has no Pi, native backend, session-store, or host-internal dependency.
4. `@nifrajs/agent-app` installs and typechecks alone with only `@nifrajs/agent-protocol` present.
5. Legacy peers continue to operate and unsupported commands fail as negotiated features, not transport errors.
6. The Workbench build emits both `dist/server.js` and `dist/public/app.js`; the local server loads the emitted module with no unresolved bare package import.

**Entry condition:** Phase 0 feature negotiation and evidence contracts are frozen.

**Stop condition:** Stop if SDK code needs provider, storage, UI framework, desktop, coding-agent, or identity dependencies, or if reconnection silently skips a sequence gap.

**Reversibility:** Costly. A new public package and SDK surface create published compatibility obligations. Workbench can temporarily roll back to its prior RPC client while protocol additions remain harmless and optional.

## Phase 3: Registry, policy, approval, and handoff

**Goal:** A local user can inspect a unified capability registry and resolve expiring approvals or handoffs while host policy remains authoritative.

**Requirements:** REG-01, REG-02, REG-03, REG-04, REG-05, REG-06, REG-07, REG-08, UX-02, UX-03, UX-04, UX-05

**Dependencies:** Phases 1 and 2.

**Public deliverables:**

- Common capability descriptor and deterministic registry snapshot in `@nifrajs/agent`.
- Core tool, MCP, and coding-agent extension descriptor adapters without moving execution ownership, including the explicit optional `mcp -> agent` and direct `coding-agent -> agent` manifest edges and documented subpath exports.
- Host policy admission and monotonic delegation enforcement.
- Typed approval and handoff lifecycle through host, protocol, Agent App SDK, and Workbench inbox.
- Registry adapter certification profiles in `@nifrajs/testing`.

**Private seam handoff:** Signed distribution, organization policy, shared identity, notification, audit retention, connector credentials, and hosted discovery remain private adapter responsibilities.

**Observable exit criteria:**

1. Core, MCP, and extension descriptor snapshots have canonical order and stable digest.
2. Collisions, schema drift, undeclared authority, expired approval, stale resolution, and unknown handoff state fail closed.
3. A Workbench user can approve, deny, assign, resolve, expire, or cancel local fixtures without seeing payload content.
4. No descriptor, extension, SDK command, or UI action can widen host capability, budget, deadline, workspace, or isolation policy.
5. All first-party descriptor adapters pass evidence-only certification.
6. Isolated dependency-direction tests prove `mcp -> agent` and `coding-agent -> agent` only, with no reverse agent or protocol edge into MCP or coding-agent.

**Entry condition:** Full orchestration lifecycle and Agent App SDK conformance pass.

**Stop condition:** Stop if registry composition becomes an invocation runtime, if MCP ownership moves out of `@nifrajs/mcp`, or if handoff ownership requires tenant identity in a public contract.

**Reversibility:** Reversible. Registry adapters and HITL projections are additive; disable negotiated registry or handoff features and retain existing approval RPC behavior if rolled back.

## Phase 4: Provider gateway and deployment contracts

**Goal:** The same agent run uses deterministic fake or replay model routes and certified local, CI, or replay deployment adapters under explicit host policy, budgets, deadlines, and isolation claims.

**Requirements:** GTW-01, GTW-02, GTW-03, GTW-04, GTW-05, GTW-06, GTW-07, DEP-01, DEP-02, DEP-03, DEP-04, DEP-05, DEP-06, DEP-07

**Dependencies:** Phase 3.

**Public deliverables:**

- Provider-neutral gateway and structured-output contracts in `@nifrajs/agent`.
- Explicit route, retry, fallback, budget, deadline, and evidence policies with deterministic fake and replay adapters.
- Deployment lifecycle and capability contracts plus local, CI, and replay reference profiles.
- Gateway and deployment certification in `@nifrajs/testing`.

**Private seam handoff:** Credentialed provider adapters, model routing operations, secret storage, pricing, spend enforcement, managed deployment, tenant routing, and fleet controls remain private or optional leaf depth.

**Observable exit criteria:**

1. Fake and replay model adapters pass one gateway suite without network access or real tools.
2. Fallback occurs only for declared retryable codes and never exceeds attempts, deadline, or budget.
3. Local, CI, and replay deployment profiles report truthful limitations and pass lifecycle cleanup tests.
4. Hostile-code fixtures are rejected unless an approved adapter declares certified OS isolation.
5. Dependency scans find no provider SDK, credential loader, fleet control, pricing, or private operated implementation in public kernels.

**Entry condition:** Registry policy and host-owned authority are enforced for tools, adapters, approvals, and handoffs.

**Stop condition:** Stop on any silent provider change, public credential handling, false sandbox claim, or adapter activation outside host policy.

**Reversibility:** Costly. Gateway and deployment contracts become public extension points; adapters remain leaf modules so implementations are replaceable without changing the contracts.

## Phase 5: At-least-once jobs and recovery

**Goal:** A run dispatched through the existing jobs lease model converges across duplicate delivery, lease expiry, cancellation, and crash boundaries using stable idempotency keys and evidence-only checkpoints.

**Requirements:** JOB-01, JOB-02, JOB-03, JOB-04, JOB-05, JOB-06, JOB-07, JOB-08

**Dependencies:** Phase 4.

**Public deliverables:**

- Run dispatch, lease, checkpoint, recovery, and injected-clock contracts in coding-agent orchestration.
- Coding-agent adapter over `@nifrajs/jobs` with at-least-once semantics, an explicit `coding-agent -> jobs` workspace dependency, and reachability through the existing orchestration export.
- Stable node idempotency keys, safe-boundary resume, cancellation, retry, and dead-letter evidence.
- Disposable memory adapter and deterministic recovery schedule fixtures.

**Private seam handoff:** Durable queues, workers, distributed leases, tenant authorization and RLS, retention, reconciliation, and fleet operations implement the public ports outside this repository.

**Observable exit criteria:**

1. Crash-before-effect, crash-after-effect, crash-after-checkpoint, duplicate delivery, expired lease, late completion, and cancellation races converge to one legal terminal state.
2. A completed side effect is never retried without matching idempotency proof.
3. Dead-letter and checkpoint records contain evidence only and fit the 4 KiB record cap.
4. `@nifrajs/jobs` remains dependency-free and contains no agent-specific types.
5. Documentation states at-least-once behavior and makes no durability or exactly-once promise for disposable adapters.
6. Isolated dependency-direction tests prove `coding-agent -> jobs` only and a packed coding-agent consumer can import the durable adapter with declared dependencies installed.

**Entry condition:** Gateway, registry, adapter policy, and deployment capability contracts are stable.

**Stop condition:** Stop if convergence requires storing tool or model payloads, if a late worker can overwrite a newer lease, or if public code needs tenant, RLS, retention, or fleet implementation details.

**Reversibility:** Costly. Stable checkpoint and idempotency formats become adapter contracts. The jobs adapter can be disabled while local in-process orchestration remains available.

## Phase 6: Evaluation and observability studio

**Goal:** CI deterministically blocks orchestration regressions and Workbench explains run, retry, recovery, trace, and eval evidence without persisting content.

**Requirements:** EVL-06, EVL-07, EVL-08, EVL-09, UX-06, UX-07, UX-08, UX-09, UX-10

**Dependencies:** Phases 2, 3, and 5.

**Public deliverables:**

- Agent eval composition across trajectory replay, fault profiles, contract lab, idempotency, and adapter certification.
- Machine-readable CI reports and explicit invariant or rubric assertion APIs.
- Cardinality-safe run telemetry and replay correlation.
- Workbench run graph, evidence timeline, trace-to-replay links, eval comparison, and fault-injection views.
- Replay-backed browser performance and visual fixtures.

**Private seam handoff:** Production traces, payload retention, alerts, cost attribution, eval corpora, labels, templates, outcomes, and accumulated fault intelligence remain private or caller-owned.

**Observable exit criteria:**

1. A seeded model, tool, approval, cancellation, lease, cursor, registry, or deployment failure reproduces the same schedule and regression ID.
2. CI exits nonzero on explicit invariant or rubric regression and never relies on an opaque aggregate score.
3. Workbench reconstructs branched, retried, paused, and recovered runs solely from SDK view models and evidence links.
4. Telemetry exporter and UI fixtures reject content-bearing or unbounded attributes.
5. Workbench meets the 16 ms p95 render and 1 second usable-view budgets with histories beyond 1,000 rows virtualized.

**Entry condition:** Recovery evidence, Agent App SDK, registry, and handoff state are stable and replayable.

**Stop condition:** Stop if useful debugging depends on retaining payloads in a public sink, if telemetry attributes are unbounded, or if UI imports backend internals.

**Reversibility:** Reversible. Eval and observability are consumers of stable evidence contracts and may be disabled independently of run execution.

## Phase 7: Compatibility and release hardening

**Goal:** Existing clients and local session users can migrate safely, all public packages pass release-equivalent gates, and private adapters have an explicit conformance handoff.

**Status:** Implementation and task-scoped verification complete; final release publication remains a human approval checkpoint.

**Requirements:** QLT-02, QLT-03, QLT-04, QLT-05, QLT-06, QLT-07, QLT-08, QLT-09, QLT-10, QLT-11, QLT-12

**Dependencies:** Phases 1 through 6.

**Public deliverables:**

- Protocol version 1 compatibility matrix and legacy `FileSessionStore` evidence-migration path.
- Security regression suite, performance checks, package consumer coverage, docs, LLM cards, API reference, changesets, and migration guides.
- Public/private adapter handoff checklist and fake private conformance fixture.
- Recorded `@nifrajs/orchestrator` extraction gate with second-consumer and coupling evidence requirements.
- Clean release-equivalent verification report.
- Dirty-path and digest baseline, task or phase write-allowlist enforcement, overlap escalation, scoped staging, and isolated-clean-worktree generation or release evidence.

**Private seam handoff:** Private implementers receive only stable ports, conformance profiles, security and RLS obligations, idempotency rules, and evidence schemas. No private topology or product naming appears publicly.

**Observable exit criteria:**

1. Old/new client-host combinations pass the protocol compatibility matrix or report negotiated unsupported features.
2. Legacy local session logs migrate to evidence-only records without changing IDs or sequence and remain recoverable under the documented rollback.
3. Focused tests, boundary and isolation checks, consumers, cross-runtime gates, corpus, coverage, performance, and `bun run check:release` pass from a clean checkout.
4. Published docs and generated corpora contain the same contracts, limitations, and private boundaries as the implementation.
5. No `@nifrajs/orchestrator` package exists unless both recorded extraction prerequisites are already proven.
6. A fake private adapter passes conformance while public boundary scans remain free of operated-depth implementation.
7. Unrelated pre-existing diffs remain byte-identical and unstaged; generated outputs are applied only after overlap checks; final release runs in an isolated clean worktree.

**Entry condition:** Every prior phase exit criterion passes and all public contract shapes are frozen for release review.

**Stop condition:** Do not release with a protocol compatibility gap, payload leak, false sandbox or exactly-once claim, missing consumer gate, stale corpus, failed performance threshold, or unreviewed public/private boundary change.

**Reversibility:** One-way at publication. Published package versions, protocol behavior, and migration guidance cannot be silently withdrawn. The release checkpoint requires explicit human approval of compatibility, privacy, and public/private diffs before publication.

## Program completion

The roadmap is complete only when all 88 requirements are verified in their single task and owner phase, the mechanical plan audit reports 24 tasks with zero missing or duplicate requirement owners and zero non-ASCII dash characters, all phase exit criteria pass, and Phase 7 completes the release-equivalent gate without modifying or staging unrelated baseline diffs. Future candidates remain out of scope until separately approved.
