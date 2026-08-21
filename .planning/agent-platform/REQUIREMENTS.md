# Nifra Agent Platform Requirements

**Status:** Planned
**Scope owner:** Public Nifra agent platform seams and local reference implementations
**Source of truth:** `.planning/agent-platform/RESEARCH.md`, `.planning/NIFRA-AGENT-WORKBENCH-PLAN.md`, and `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`
**Requirement count:** 88 in scope

## Interpretation rules

- Each requirement is atomic, testable, and owned by exactly one roadmap phase.
- "Reference" means public, local, disposable, and moat-neutral. It never means operated or multi-tenant.
- "Evidence" is the bounded metadata allowlist in BND-01. Anything else is content and cannot enter a public reference sink.
- "Artifact" means caller-owned content addressed through an opaque port or reference. Nifra public reference implementations do not persist artifact contents.
- Protocol work evolves protocol version 1 additively and uses feature negotiation. A new protocol major is not authorized by this program.
- Dispatch is at least once. Stable idempotency keys and convergence tests are required; exactly-once behavior is not claimed.
- Local process, runner, replay, and extension-worker adapters are trusted-local execution mechanisms, not hostile-code sandboxes.

## Boundary and privacy

| ID | Atomic requirement | Verification | Owner phase |
| --- | --- | --- | --- |
| BND-01 | Define `RunEvidence`, `EvidenceRef`, and `ArtifactRef` value contracts whose serializable evidence fields are limited to IDs, timestamps, hashes or digests, bounded counters, capability names, status or error codes, durations, and schedule tokens. | Type fixtures and property tests accept every allowed field class and reject every other key. | 0 |
| BND-02 | Make every new public reference store, reporter, exporter, snapshot, benchmark record, and eval report accept evidence values only and fail closed on content fields or records larger than 4 KiB. | A shared forbidden-field corpus proves rejection for prompt, text, input, output, body, secret, diagnostic, example, artifact, and unknown nested keys. | 0 |
| BND-03 | Provide an optional caller-owned `ArtifactPort` that receives opaque references and caller-defined content outside all public reference sinks. | Contract tests prove the platform runs with no artifact port and never reads or persists content through reference evidence adapters. | 0 |
| BND-04 | Keep durable scheduling, tenant identity and RLS, provider credentials, retention, billing and spend enforcement, notifications, hosted discovery, remote fleet control, and accumulated eval or fault intelligence outside the public repository implementation. Enforce this with a generic operated-depth implementation deny policy that does not depend on private product names, plus an additive private-marker scan that fails closed in CI and release mode when marker configuration is absent. | Generic negative fixtures for an undeclared operated adapter and prohibited runtime edge fail even with `PRIVATE_MARKERS` unset; CI-without-markers and a configured sentinel marker both fail; an allowlisted disposable reference passes; the release gate requires non-empty marker configuration. | 0 |
| BND-05 | Keep all agent-platform packages out of `@nifrajs/core`, `@nifrajs/client`, `@nifrajs/web`, and `@nifrajs/schema` dependency paths unless explicitly installed by an application. | `check:agent-boundary`, public-boundary checks, and bare-consumer tests pass with agent packages absent. | 0 |
| BND-06 | Parse protocol messages, run plans, registry descriptors, gateway responses, job callbacks, evidence records, and deployment callbacks before use instead of relying on type casts. | Malformed and unknown input fixtures fail with stable typed error codes before handlers run. | 0 |
| BND-07 | Make authority host-owned and delegation monotonic across capability, budget, deadline, workspace, approval, and isolation requirements. | Property tests prove every child vector is a subset of its parent and self-grant attempts fail closed. | 0 |
| BND-08 | Label local process, runner, replay, and extension-worker adapters as non-sandboxed and require a declared OS-isolation capability before accepting hostile-code workloads. | Documentation corpus checks and adapter certification reject any local adapter claiming hostile-code isolation. | 0 |

## Run plans and orchestration

| ID | Atomic requirement | Verification | Owner phase |
| --- | --- | --- | --- |
| ORC-01 | Define a serializable `RunPlan` with version, plan ID, node IDs, dependency IDs, registered step keys, input artifact references, capability vector, budget vector, deadline, workspace policy, retry policy, checkpoint policy, and optional handoff policy. | Round-trip fixtures contain no functions or content payloads and validate under the protocol parser. | 0 |
| ORC-02 | Reject duplicate node IDs, missing dependencies, cycles, unsupported versions, unknown step keys, invalid limits, and plans exceeding 256 nodes before execution. | Focused compiler tests assert a stable error code for every invalid graph class. | 0 |
| ORC-03 | Compile one validated declarative task node through a `StepCatalog` into the existing `WorkflowRunner` and emit evidence for accepted, started, completed, and verified transitions. | An end-to-end tracer test executes through the real runner and passes an eval invariant without provider-specific code. | 0 |
| ORC-04 | Compile sequence, bounded parallel, verify, approve, retry, branch, checkpoint, handoff, and bounded subagent nodes into existing workflow and subagent primitives without creating a second execution engine. | Compiler parity tests cover every declarative node kind and compare terminal results with direct `WorkflowStep` fixtures. | 1 |
| ORC-05 | Add `StepCatalog` registration with unique versioned step keys, parsed input contracts, declared capabilities, output artifact-reference contracts, and deterministic lookup. | Collision, missing-step, version-drift, and invalid-input tests fail before node execution. | 1 |
| ORC-06 | Add `OrchestrationHost` lifecycle operations for submit, inspect, start, pause at a safe boundary, resume, cancel, and terminal result query. | State-machine tests reject illegal transitions and prove cancellation propagation. | 1 |
| ORC-07 | Enforce plan, node, depth, child-count, concurrency, retry, deadline, budget, and workspace ceilings before and during execution. | Boundary tests exercise exact limits and one-over-limit failures with stable evidence codes. | 1 |
| ORC-08 | Reuse `BoundedSubagentRunner`, `ApprovalManager`, verification, checkpoints, and `WorkflowRunner`; do not duplicate their execution or policy logic. | Dependency and source checks prove orchestration imports these owners and contains no parallel runner implementation. | 1 |
| ORC-09 | Provide evidence-only memory and file adapters for local run lifecycle records, both with bounded live windows and deterministic ordering. | Serialization tests reject content and soak tests prove bounded memory at 1k, 10k, and 100k evidence events. | 1 |
| ORC-10 | Produce a deterministic terminal run result containing status, completed node IDs, evidence digest, artifact references, counters, and stable failure code without embedding step outputs. | Snapshot and property tests prove equal inputs and schedules produce equal results and no output payload is serialized. | 1 |

## Protocol and Agent App SDK

| ID | Atomic requirement | Verification | Owner phase |
| --- | --- | --- | --- |
| APS-01 | Add optional protocol version 1 feature negotiation and evidence-safe run metadata without changing the meaning of any existing required field or event. | Frozen legacy protocol fixtures decode unchanged and new peers can negotiate the tracer feature set. | 0 |
| APS-02 | Add additive protocol version 1 value contracts for `RunPlanRef`, `RunSnapshot`, `RunEvidenceEvent`, `HandoffSnapshot`, `EvidenceRef`, and opaque artifact references. | Old decoders ignore additions, new decoders parse legacy messages, and protocol conformance fixtures cover each value. | 2 |
| APS-03 | Add cursor semantics that resume evidence streams after a supplied sequence and return an explicit stale-cursor or resync-required result when the bounded window no longer contains the cursor. | Disconnect/reconnect tests prove ordered, gap-aware delivery without silent loss. | 2 |
| APS-04 | Create the only new initial public package, `@nifrajs/agent-app`, depending only on `@nifrajs/agent-protocol`. | Package manifest, build graph, and isolated consumer test prove no React, Pi, coding-agent, provider, storage, or desktop dependency. | 2 |
| APS-05 | Expose a typed `AgentAppClient` command facade for negotiated capabilities, run submission and query, cancellation, approval and handoff resolution, replay selection, and evidence streaming. | Type tests and fake-backend integration tests cover every command and unsupported-feature failure. | 2 |
| APS-06 | Supply caller-provided authentication and Web-standard fetch or SSE transport without storing credentials or inventing identity policy. | Tests verify credentials are only attached by the caller hook and are absent from errors, evidence, and logs. | 2 |
| APS-07 | Deduplicate reconnect deliveries by stable event identity while preserving strict per-run sequence order and surfacing gaps. | Randomized stream tests inject duplicates, reorderings, disconnects, and bounded-window gaps. | 2 |
| APS-08 | Export presentation-safe view models containing only negotiated capabilities, run topology, statuses, evidence counters, approvals, handoffs, and opaque artifact references. | A forbidden-field type/runtime corpus cannot construct or parse prompt, model, tool, diagnostic, or artifact content in a view model. | 2 |
| APS-09 | Certify `AgentAppClient` against fake and replay backends and the local RPC host without requiring Pi or a model call. | The same conformance suite passes for all three backends with network disabled for fake and replay cases. | 2 |

## Registry and policy

| ID | Atomic requirement | Verification | Owner phase |
| --- | --- | --- | --- |
| REG-01 | Define a versioned `CapabilityDescriptor` for tools, MCP tools, extensions, model adapters, and deployment adapters with stable name, version, kind, schema digest, required capabilities, approval policy, retry class, idempotency class, and isolation requirement. | Parser fixtures accept valid descriptors and reject missing, unknown, or content-bearing fields. | 3 |
| REG-02 | Adapt Nifra core tool contracts into `CapabilityDescriptor` without changing core tool execution contracts. | Descriptor parity tests compare names, schema digests, and capability declarations. | 3 |
| REG-03 | Adapt MCP tool contracts into the common descriptor through an exported optional `@nifrajs/mcp/agent-descriptor` subpath with an explicit `@nifrajs/mcp` to `@nifrajs/agent` manifest edge, while keeping MCP transport and invocation owned by `@nifrajs/mcp`. | MCP adapter, isolated-consumer, manifest, and dependency-direction tests prove descriptor parity, the declared optional edge, and no reverse dependency from agent or protocol packages into MCP transport. | 3 |
| REG-04 | Adapt coding-agent extension tools and provider descriptors into the common descriptor without allowing extensions to activate undeclared authority. | Extension fixtures with escalated or omitted capabilities fail closed before registration. | 3 |
| REG-05 | Compose deterministic registry snapshots with collision detection, canonical ordering, schema digests, and a snapshot digest. | Reordered input yields the same digest; collisions and drift produce stable error codes. | 3 |
| REG-06 | Resolve capability admission, approval requirement, retry eligibility, idempotency requirement, and isolation requirement through host policy before invocation. | Denial and approval-expiry tests prove the descriptor or model cannot override host policy. | 3 |
| REG-07 | Enforce monotonic capability, budget, deadline, and workspace delegation when a registered capability creates child work. | Property tests generate parent and child vectors and reject every expanded child vector. | 3 |
| REG-08 | Publish registry and adapter certification profiles that use disposable descriptors and evidence-only reports. | Every first-party descriptor adapter passes certification and report serialization rejects content. | 3 |

## Provider and model gateway

| ID | Atomic requirement | Verification | Owner phase |
| --- | --- | --- | --- |
| GTW-01 | Define provider-neutral `ModelGateway`, `ModelGatewayRequest`, `ModelGatewayResult`, `ModelGatewayError`, `StructuredOutputParser`, and `ModelRoutePolicy` contracts in `@nifrajs/agent`. | Public API tests compile with no provider SDK installed and parse all boundary values. | 4 |
| GTW-02 | Validate structured model output before returning it to an agent and classify malformed, refusal, timeout, rate-limit, unavailable, policy, cancelled, and internal failures with stable codes. | Fake-provider tests cover every result and error branch, including malformed success payloads. | 4 |
| GTW-03 | Permit retry or fallback only for caller-declared retryable codes, within remaining attempts, deadline, and budget, and never silently change provider or model. | Policy tests prove non-retryable errors stop, route changes are evidenced, and exhausted vectors fail closed. | 4 |
| GTW-04 | Propagate a monotonic budget and deadline envelope through every gateway attempt and expose bounded usage counters without public pricing or spend enforcement. | Property tests prove remaining values never increase and no amounts, prices, or credential data enter public evidence. | 4 |
| GTW-05 | Emit evidence-only attempt, fallback, parse, and terminal records with provider and model represented by caller-safe opaque route IDs. | Forbidden-field tests reject prompts, messages, response bodies, raw diagnostics, and credentials. | 4 |
| GTW-06 | Provide deterministic fake and replay gateway adapters that perform no network or real tool execution. | Network-denial tests and replay digest assertions pass deterministically. | 4 |
| GTW-07 | Keep credentialed provider implementations as optional leaf adapters outside the gateway kernel and outside this public program's implementation. | Dependency scans show no provider SDK or credential loader in protocol, agent-app, agent, testing, or orchestration modules. | 4 |

## Jobs and recovery

| ID | Atomic requirement | Verification | Owner phase |
| --- | --- | --- | --- |
| JOB-01 | Define `RunDispatchStore`, `RunLease`, `RunCheckpoint`, `RunDispatch`, and injected clock contracts with evidence-only values and no tenant, credential, or retention policy. | Contract tests reject content and validate lease or checkpoint invariants. | 5 |
| JOB-02 | Add a coding-agent durable-jobs adapter over the existing `@nifrajs/jobs` `JobStore` semantics, declare the `@nifrajs/coding-agent` to `@nifrajs/jobs` workspace dependency, and expose the adapter through the existing orchestration subpath without adding agent concepts to `@nifrajs/jobs`. | Manifest, export, isolated-consumer, and dependency-direction tests prove the edge points only from coding-agent to jobs and the jobs package remains agent-free and dependency-free at runtime. | 5 |
| JOB-03 | Dispatch every run node at least once with a stable idempotency key derived from plan digest, run ID, node ID, and logical attempt boundary. | Duplicate-delivery tests prove the same logical node receives the same key and divergent effects are detected. | 5 |
| JOB-04 | Resume only from persisted safe checkpoints and never replay a completed side effect without its idempotency proof. | Crash-before-effect, crash-after-effect, and crash-after-checkpoint failure tests converge without double commit. | 5 |
| JOB-05 | Handle lease expiry, worker loss, retry backoff, cancellation races, and late completion with explicit state transitions and stable evidence codes. | Injected-clock tests exercise every interleaving and reject illegal late writes. | 5 |
| JOB-06 | Dead-letter exhausted work as evidence containing identifiers, attempts, terminal code, schedule token, and digest only. | Serialization tests reject error text, diagnostics, inputs, outputs, and artifacts in dead-letter records. | 5 |
| JOB-07 | Provide disposable memory adapters and deterministic recovery schedules for tests and local single-process use while making no durability or exactly-once claim. | Restart simulations and documentation corpus tests assert the stated limitations. | 5 |
| JOB-08 | Expose private adapter handoff contracts for durable queues, workers, data-layer authorization, RLS, retention, and fleet control without implementing them publicly. | Interface conformance fixtures compile against a fake private adapter and public-boundary scans find no operated implementation. | 5 |

## Evaluation and replay

| ID | Atomic requirement | Verification | Owner phase |
| --- | --- | --- | --- |
| EVL-01 | Define evidence-only `AgentEvalCase` and `AgentEvalReport` contracts in `@nifrajs/testing` using IDs, plan or transcript digests, fault schedule tokens, invariant IDs, rubric outcomes, counters, and status codes only. | Parser and serialization tests reject prompts, examples, model text, tool payloads, raw trajectories, and artifacts. | 0 |
| EVL-02 | Evaluate the phase-0 declarative tracer with a deterministic invariant that proves accepted, started, completed, verified ordering and matching evidence digest. | The tracer test starts from a fake/replay backend and produces the same report digest on repeated runs. | 0 |
| EVL-03 | Add `defineAgentEvalSuite`, deterministic suite execution, and explicit case ordering on top of existing trajectory and failure-lab primitives. | Reordered suite declarations normalize deterministically or fail on duplicate case IDs. | 1 |
| EVL-04 | Add typed rubric ports whose public output is a bounded enum or numeric outcome plus code and digest, never free-form evaluator reasoning. | Rubric tests reject unbounded text and invalid ranges and run with a deterministic fake. | 1 |
| EVL-05 | Add baseline comparison over invariant outcomes, rubric outcomes, counters, and digests with explicit tolerances and regression IDs. | Tests cover improvement, equality, allowed tolerance, regression, missing baseline, and incomparable schema. | 1 |
| EVL-06 | Compose agent evals with trajectory replay, fault profiles, contract lab, idempotency proofs, and adapter certification without creating duplicate replay or failure engines. | Integration tests invoke the existing primitives and source/dependency checks show one owner for each mechanism. | 6 |
| EVL-07 | Provide deterministic failure matrices for model, tool, approval, cancellation, lease, cursor, registry, and deployment boundaries. | Fixed seeds and schedule tokens reproduce the same failure and regression IDs. | 6 |
| EVL-08 | Emit machine-readable CI reports and a failing assertion API based only on explicit invariants, rubrics, tolerances, and codes, with no opaque aggregate agent score. | CI fixture exits nonzero on a known regression and report schema excludes content. | 6 |
| EVL-09 | Keep corpora, prompts, labels, production outcomes, tuned templates, and accumulated fault intelligence caller-owned or private. | Public package fixtures contain no retained dataset and boundary scans reject corpus or example stores. | 6 |

## Telemetry, Workbench, and human handoff

| ID | Atomic requirement | Verification | Owner phase |
| --- | --- | --- | --- |
| UX-01 | Refactor Workbench production browser code to a typed `src/browser.ts` entrypoint that consumes `@nifrajs/agent-app` commands, streams, and view models, declares the workspace dependency, bundles to `dist/public/app.js`, and is served from that built asset path while keeping coding-agent only in the local launcher. | The package build emits the browser bundle and server bundle, the local server returns the emitted asset without unresolved bare imports, and a replay-backed built-asset smoke plus dependency scan finds no Pi, native backend, session-file, or host-internal import in production UI code. | 2 |
| UX-02 | Define typed approval and handoff lifecycles with requested or offered, assigned, resolved, denied, expired, and cancelled terminal behavior plus bounded ownership reference and expiry timestamp. | State-machine tests reject unknown, duplicate, late, and authority-expanding transitions. | 3 |
| UX-03 | Extend the local approval broker into a host-owned approval and handoff coordinator that expires closed and resumes only the matching paused run boundary. | Concurrent-request tests prove decisions cannot resolve another run, node, or capability. | 3 |
| UX-04 | Expose approval and handoff list, inspect, resolve, deny, and cancel commands through negotiated protocol and Agent App SDK features. | Fake-client conformance covers authorized commands, unsupported features, expiry, stale decisions, and cancellation. | 3 |
| UX-05 | Add a Workbench inbox for pending approvals and handoffs with capability, run, node, expiry, and evidence context only. | Replay-backed UI tests complete approve, deny, assign, resolve, expire, and cancelled flows without rendering payload content. | 3 |
| UX-06 | Extend agent telemetry with run, plan, node, attempt, evidence, and replay correlation using an explicit cardinality-safe attribute allowlist. | Exporter tests reject content keys and unbounded attributes and preserve correlation across retry. | 6 |
| UX-07 | Add a Workbench run graph showing dependencies, active state, checkpoints, retries, cancellations, and terminal status from SDK view models. | Browser tests replay branched and parallel fixtures and assert graph state at each cursor. | 6 |
| UX-08 | Add an evidence timeline with trace-to-replay links that use opaque digests and schedule tokens rather than retained payloads. | UI and exporter tests prove every link resolves to evidence or caller-owned artifacts without reading session JSONL. | 6 |
| UX-09 | Add eval comparison and fault-injection views that display explicit invariant or rubric deltas, counters, and codes without opaque scores or example content. | Browser snapshots cover pass, tolerance, regression, incomparable, and injected-fault states. | 6 |
| UX-10 | Virtualize histories beyond 1,000 rows and meet p95 evidence-event-to-render of 16 ms with the orchestration view usable within 1 second after local RPC readiness. | Replay browser benchmark enforces both latency budgets and bounded DOM or memory growth. | 6 |

## Deployment adapters

| ID | Atomic requirement | Verification | Owner phase |
| --- | --- | --- | --- |
| DEP-01 | Define a provider-neutral `AgentDeploymentAdapter` lifecycle for prepare, start, inspect, cancel, dispose, and capability report using Web-standard values and evidence-only results. | Contract parser and fake-adapter tests cover every lifecycle transition and invalid callback. | 4 |
| DEP-02 | Require each adapter to declare runtime, network, filesystem, process, secret, workspace, hostile-code-isolation, and cancellation capabilities before activation. | Missing or overstated declarations fail certification before start. | 4 |
| DEP-03 | Provide local process, CI, and replay reference adapter profiles with truthful limitations and no remote fleet or secret-management implementation. | Disposable fixtures pass conformance and documentation checks find the non-sandbox limitation. | 4 |
| DEP-04 | Add deployment adapter certification to `@nifrajs/testing`, including lifecycle, cancellation, evidence, cleanup, capability, and isolation-claim checks. | All reference adapters pass; deliberately lying and leaking adapters fail named checks. | 4 |
| DEP-05 | Require an approved adapter declaring real OS isolation before a plan marked hostile-code can start. | Policy tests reject local process, runner, replay, and extension worker for hostile-code fixtures. | 4 |
| DEP-06 | Keep managed deployment, remote execution, credential distribution, tenant routing, and fleet controls in private operated adapters. | Public boundary scan finds only contracts, fakes, and local or CI reference adapters. | 4 |
| DEP-07 | Keep adapter activation under host policy and monotonic delegation, including cancellation and workspace ceilings. | Child deployment property tests cannot widen any parent authority vector. | 4 |

## Compatibility, security, performance, and documentation

| ID | Atomic requirement | Verification | Owner phase |
| --- | --- | --- | --- |
| QLT-01 | Freeze legacy protocol version 1, replay, fake-backend, and `FileSessionStore` fixtures before adding tracer contracts. | Golden fixtures pass before and after phase-0 additions with unchanged legacy semantics. | 0 |
| QLT-02 | Preserve protocol version 1 compatibility through additive optional fields and feature negotiation; require a recorded semantic incompatibility and dual-decoder plan before any future major protocol change. | Compatibility matrix covers old client/new host, new client/old host, new/new, and unsupported feature negotiation. | 7 |
| QLT-03 | Keep `FileSessionStore` legacy read and explicit local compatibility behavior, add an evidence-only migration command or mode, and never use legacy payload logs as the new control-plane store. | Migration fixtures preserve IDs and sequence while excluding legacy content; docs state local retention and rollback behavior. | 7 |
| QLT-04 | Run security tests for parsing, capability escalation, approval expiry, workspace and symlink escape, evidence leakage, remote binding, adapter claims, and credential redaction. | Every named threat has at least one failing-before-mitigation regression test and a stable failure code. | 7 |
| QLT-05 | Run `nifra check --json`, focused Bun tests, `check:agent-boundary`, `check:agent-isolation`, public-boundary checks, and the agent-platform plan audit for every phase in proportion to touched packages. The plan audit requires one non-empty task owner for each of the 88 requirements, no duplicate ownership, valid task and phase write allowlists, and ASCII hyphens in agent-platform artifacts. | CI logs show each applicable command succeeds; the plan audit reports 24 tasks, 88 unique requirements, zero duplicates, zero missing IDs, zero out-of-allowlist task definitions, and zero non-ASCII dash characters; missing configured assurance fails closed. | 7 |
| QLT-06 | Add `@nifrajs/agent-app` and changed public surfaces to build, publish, type generation, isolated consumer, Node or Deno as applicable, size, cold-start, and package-boundary matrices. | Packaged consumers import only documented exports with workspace packages absent. | 7 |
| QLT-07 | Enforce the run-plan, scheduler, evidence, gateway, replay, Workbench, memory, package-size, and cold-start budgets recorded in PROGRAM-PLAN.md using payload-free benchmarks. | Each budget has a deterministic check command and checked-in threshold or measured baseline. | 7 |
| QLT-08 | Update package READMEs, LLM cards, API reference, security guidance, troubleshooting, Workbench docs, and public migration guides, then regenerate and verify the documentation corpus. | `check:corpus`, `check:docs`, and API or card checks pass with no stale examples. | 7 |
| QLT-09 | Add changesets and migration notes for every changed public package and the new Agent App SDK without exposing private product names or implementation topology. | Changeset coverage and public-boundary scans pass. | 7 |
| QLT-10 | Record an extraction gate for a future `@nifrajs/orchestrator`: extraction is allowed only after a second production non-coding-agent consumer exists and dependency analysis proves the package reduces coupling. | An architecture test or decision record blocks package creation until both evidence fields are present. | 7 |
| QLT-11 | Run package consumer, corpus, performance, security, cross-runtime, coverage, and `bun run check:release` gates before the program is declared complete. Before generation or release, record dirty paths and digests, enforce task and phase write allowlists, stop on overlapping unrelated changes, scope staging and reports to program-owned paths, and run the release-equivalent gate in an isolated clean worktree. | Worktree guard fixtures reject changed or staged paths outside the active allowlist; generation refuses a dirty overlapping target; unrelated baseline diffs remain byte-identical and unstaged; the release-equivalent command succeeds from a clean checkout and generated files have no diff. | 7 |
| QLT-12 | Publish a public/private handoff checklist that requires private adapters to enforce data-layer authorization and RLS, credentials, retention, idempotent dispatch, and no PII in logs without encoding those implementations in public packages. | A fake private adapter completes the checklist and certification while the public boundary scan remains clean. | 7 |

## Future candidates

These are not requirements in this program. Promoting one requires an explicit roadmap change and public/private review.

| Candidate | Promotion gate |
| --- | --- |
| Extract `@nifrajs/orchestrator` | A second production non-coding-agent consumer exists and dependency analysis demonstrates lower coupling than `coding-agent/orchestration`. |
| Protocol version 2 | An additive version 1 feature cannot represent a proven semantic incompatibility, with dual-decoder and migration fixtures approved first. |
| Signed desktop artifacts | Tauri toolchain, signing, updater, and platform release policy are separately scoped. |
| Remote and mobile client transport | Short-lived authentication, encrypted opt-in transport, revocation, and remote threat model are approved. |
| Credentialed provider packages | Each provider is scoped as an optional leaf package with secret handling and provider-specific certification. |
| OS hostile-code isolation adapters | A platform-specific isolation design and truthful capability certification are available. |
| Additional production deployment adapters | A concrete non-local consumer and adapter contract evidence justify the package. |

## Out of scope

| Excluded capability | Reason |
| --- | --- |
| Public durable database, scheduler, queue service, retained session service, or distributed lock implementation | Operated durable state is private depth. |
| Tenant identity, RLS schema, organization policy, entitlement, pricing, billing, or spend enforcement | Identity and economics are force-private. |
| Credential vault, provider keys, hosted connectors, or vendor account setup | Credentialed integrations are force-private. |
| Stored prompts, transcripts, model responses, tool inputs or outputs, response bodies, diagnostics, examples, eval corpora, artifacts, or production fault intelligence | Payload retention and accumulated data are force-private. |
| Hosted discovery, notifications, remote fleet operations, or managed deployments | Operated multi-user services are private depth. |
| Exactly-once execution guarantees | The architecture is at least once with stable idempotency keys. |
| A second workflow runtime, DAG executor, or public orchestration package in the initial implementation | Declarative plans compile into the existing `WorkflowRunner`. |
| Treating local process, runner, replay, or extension worker as a hostile-code sandbox | These adapters do not provide OS isolation. |
| Workbench imports of Pi, native backend internals, host session files, or private operated APIs | Production UI is protocol and Agent App SDK driven. |

## Traceability and coverage audit

| Source category | Requirement IDs | Count | Roadmap owner |
| --- | --- | ---: | --- |
| Boundary and privacy | BND-01 through BND-08 | 8 | Phase 0 |
| Run plans and orchestration | ORC-01 through ORC-03 | 3 | Phase 0 |
| Protocol and SDK tracer | APS-01 | 1 | Phase 0 |
| Eval tracer | EVL-01 through EVL-02 | 2 | Phase 0 |
| Compatibility baseline | QLT-01 | 1 | Phase 0 |
| Orchestration expansion | ORC-04 through ORC-10 | 7 | Phase 1 |
| Eval feedback core | EVL-03 through EVL-05 | 3 | Phase 1 |
| Protocol and Agent App SDK | APS-02 through APS-09 | 8 | Phase 2 |
| Workbench SDK adoption | UX-01 | 1 | Phase 2 |
| Registry and policy | REG-01 through REG-08 | 8 | Phase 3 |
| Approval, handoff, and inbox | UX-02 through UX-05 | 4 | Phase 3 |
| Provider gateway | GTW-01 through GTW-07 | 7 | Phase 4 |
| Deployment adapters | DEP-01 through DEP-07 | 7 | Phase 4 |
| Jobs and recovery | JOB-01 through JOB-08 | 8 | Phase 5 |
| Eval lab expansion | EVL-06 through EVL-09 | 4 | Phase 6 |
| Telemetry and Workbench studio | UX-06 through UX-10 | 5 | Phase 6 |
| Compatibility, security, performance, and docs | QLT-02 through QLT-12 | 11 | Phase 7 |
| **Total mapped once** | **BND, ORC, APS, REG, GTW, JOB, EVL, UX, DEP, QLT** | **88 / 88** | **100%** |

### Multi-source coverage audit

| Source | Scope item | Requirement coverage | Status |
| --- | --- | --- | --- |
| Goal | Local orchestration control plane | ORC-01 through ORC-10, JOB-01 through JOB-08 | Covered |
| Goal | Deterministic evaluation and replay lab | EVL-01 through EVL-09 | Covered |
| Goal | Typed Agent App SDK | APS-01 through APS-09 | Covered |
| Goal | Provider and model gateway | GTW-01 through GTW-07 | Covered |
| Goal | Unified tool and MCP capability registry | REG-01 through REG-08 | Covered |
| Goal | Observability studio | UX-06 through UX-10 | Covered |
| Goal | Human approval and handoff inbox | UX-02 through UX-05 | Covered |
| Goal | Durable agent jobs seam | JOB-01 through JOB-08 | Covered |
| Goal | Deployment contracts and certification | DEP-01 through DEP-07 | Covered |
| Goal | Workbench integration | UX-01, UX-05, UX-07 through UX-10 | Covered |
| Research | Evidence and artifact separation | BND-01 through BND-03, EVL-01, UX-06, JOB-06 | Covered |
| Research | Public/private seam | BND-04, JOB-08, GTW-07, DEP-06, EVL-09, QLT-12 | Covered |
| Research | Protocol and legacy migration hazards | APS-01 through APS-09, QLT-01 through QLT-03 | Covered |
| Research | At-least-once and idempotency | JOB-03 through JOB-07 | Covered |
| Context | Reuse `WorkflowRunner`; no initial orchestrator package | ORC-03, ORC-04, ORC-08, QLT-10 | Covered |
| Context | One new protocol-only public package | APS-04, QLT-06 | Covered |
| Context | Host-owned monotonic authority | BND-07, ORC-07, REG-06 through REG-07, DEP-07 | Covered |
| Context | Local adapters are not sandboxes | BND-08, DEP-02 through DEP-05 | Covered |
| Context | Workbench stays backend-neutral | APS-09, UX-01 | Covered |
| Deferred and excluded | Operated depth, remote/mobile transport, Tauri release, protocol v2, orchestration extraction | Future candidates and Out of scope tables | Excluded by decision |

There are no unplanned in-scope items. All 88 in-scope requirements map to exactly one roadmap phase.
