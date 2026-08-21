# Nifra Agent Platform Expansion - Research

**Researched:** 2026-08-20
**Scope:** orchestration control plane, deterministic evaluation/replay, typed Agent App SDK, provider gateway, tool registry, observability, human handoff, durable jobs, deployment adapters, and Workbench
**Confidence:** HIGH for current-state inventory; MEDIUM for phased design recommendations

## Executive Recommendation

Build the platform as a set of public, moat-neutral contracts and local reference implementations, with a separate **private operated layer** implementing durable scheduling, tenant/identity policy, credentialed provider routing, payload retention, and aggregate evaluation intelligence. [VERIFIED: `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`] The public entry point should be an extension of the existing agent product, not a second workflow runtime: `WorkflowRunner`, `BoundedSubagentRunner`, `ApprovalManager`, `NifraBackend`, `ReplayBackend`, `CodingAgentRpcServer`, and the Workbench shell already cover the local control loop. [VERIFIED: `packages/coding-agent/src/workflows.ts:8-181`; `packages/coding-agent/src/subagents.ts`; `packages/coding-agent/src/approvals.ts`; `packages/coding-agent/src/native.ts`; `packages/coding-agent/src/replay.ts`; `packages/coding-agent/src/rpc.ts`; `apps/workbench/src/server.ts`]

The first implementation target is a **local orchestration control plane**: typed run plans, a host-owned scheduler facade, durable-state interfaces, handoff state, evidence-only run records, and a protocol/Workbench projection. It must be able to use the existing in-process workflow runner and the existing `@nifrajs/jobs` queue as reference adapters. A future private operated layer may satisfy the same interfaces, but the public repository must never ship a payload-persisting reference sink for user prompts, model responses, tool inputs, tool outputs, or evaluation examples. This is the key non-negotiable migration rule because the present local session store accepts bounded/redacted event payloads and host code appends protocol events to it. [VERIFIED: `packages/coding-agent/src/sessions.ts:4-108`; `packages/coding-agent/src/host.ts:85-164`]

**Primary recommendation:** Add contracts and evidence-only reference adapters first; only then add UX, provider routing, and durable adapters behind those contracts.

## Current Capability Inventory

| Existing surface | What it already owns | Planning consequence |
|---|---|---|
| `@nifrajs/agent-protocol` | Versioned session snapshots, streamed events, backend interface, bounded live event queue; it intentionally has no runtime/framework/provider/UI dependencies. [VERIFIED: `packages/agent-protocol/src/index.ts:1-30`; `packages/agent-protocol/README.md`] | Keep it the wire-contract root. Extend it compatibly for run/handoff/event metadata; do not put scheduling or a provider SDK here. |
| `@nifrajs/agent` | Provider-neutral typed turns, tool contracts, approval/budget/state/telemetry ports, dry-run replay, idempotency and execution-policy injection. [VERIFIED: `packages/agent/src/index.ts`; `packages/agent/README.md`] | Make this the source of generic model-gateway and capability-admission interfaces; preserve provider neutrality. |
| `@nifrajs/coding-agent` | Local host/CLI/RPC, JSONL sessions, compaction, extensions, workflows, bounded subagents, approvals, verification, native/replay backends, controlled UI manifests. [VERIFIED: `packages/coding-agent/README.md`; `packages/coding-agent/src/index.ts`] | Add the orchestration coordinator as a module here initially-do not create a package merely to rename this behavior. |
| `WorkflowRunner` | Task, sequence, parallel, verify, approve, retry, branch, checkpoint, handoff; step/depth/concurrency bounds. [VERIFIED: `packages/coding-agent/src/workflows.ts:8-181`] | Reuse as the local executor. Add a compiled declarative `RunPlan` and a scheduler adapter around it; do not replace it with a DAG engine in phase one. |
| `BoundedSubagentRunner` | Child-count/depth/timeout/capability/workspace ceilings and cancellation propagation. [VERIFIED: `packages/coding-agent/src/subagents.ts`] | Use it as the run-plan subagent executor; add cost/model budget delegation rather than a parallel child runner. |
| `ApprovalManager` | Bounded, expiring-closed local approval broker shared by RPC, Workbench, and workflows. [VERIFIED: `packages/coding-agent/src/approvals.ts`] | Generalize its request/decision evidence format and add human handoff ownership/SLA fields; keep authority host-owned. |
| `NifraBackend` and `ReplayBackend` | Provider-SDK-free model/tool loop and deterministic protocol playback. [VERIFIED: `packages/coding-agent/src/native.ts`; `packages/coding-agent/src/replay.ts`; `packages/coding-agent/README.md`] | Keep both; a gateway feeds `NifraBackend` through its model port, while replay remains a no-provider CI backend. |
| `@nifrajs/testing` | Deterministic failure lab, fault profiles, trajectory transcript/replay/invariants, contract lab, adapter certification and redacted incident-to-test tooling. [VERIFIED: `packages/testing/README.md`; `packages/testing/src/trajectory.ts`; `packages/testing/src/failure-lab.ts`; `packages/testing/src/certification.ts`; `packages/testing/src/incident.ts`] | This is the evaluation lab substrate. Build a thin agent-eval composition API here, not an unrelated eval framework. |
| `@nifrajs/mcp` | Typed MCP tools, schema validation, capability-aware core-tool adapter, HTTP/SSE transport, widgets. [VERIFIED: `packages/mcp/README.md`; `packages/mcp/src/tool-contract.ts`; `packages/mcp/src/tool.ts`] | Registry should normalize existing tool catalog/MCP descriptors instead of inventing a third tool schema. |
| `@nifrajs/agent-telemetry` | Child spans for tool/MCP calls: tool name, input/output byte counts, duration, status; no capture of payload content in its plugin contract. [VERIFIED: `packages/agent-telemetry/README.md`; `packages/agent-telemetry/src/index.ts`] | Extend with run/step correlation and cardinality-safe counters/digests only. |
| `@nifrajs/jobs` | Typed queue, validation-at-enqueue, retry/backoff/dead-letter, at-least-once lease interface, pluggable durable store. [VERIFIED: `packages/jobs/README.md`; `packages/jobs/src/types.ts`] | Reuse `JobStore` semantics for durable run dispatch. Do not claim exactly-once agent execution; enforce idempotent effects. |
| `@nifrajs/runner` | Bounded structured request execution across Web-standard runtimes; explicitly not a security sandbox. [VERIFIED: `packages/runner/README.md`] | Use it for app verification fixtures and deployment-adapter conformance, never for untrusted code isolation. |
| Workbench | Local browser shell over token-authenticated loopback JSON/SSE RPC with controlled workflow/UI extension discovery. [VERIFIED: `apps/workbench/README.md`; `apps/workbench/src/server.ts`] | Add orchestration/eval/approval views to this shell; it must remain backend-neutral and own security/approval navigation. |

## Overlap and Gap Matrix

| Proposed capability | Existing overlap | Actual gap | Verdict |
|---|---|---|---|
| Orchestration control plane | Workflow/subagent runners, RPC, checkpoints and jobs all exist. [VERIFIED: `packages/coding-agent/src/workflows.ts`; `packages/coding-agent/src/subagents.ts`; `packages/jobs/README.md`] | Declarative run plan, dependency scheduler interface, run lifecycle model, durable coordinator/store ports, recovery semantics. | Extend `coding-agent`; extract only stable contracts later. |
| Deterministic eval/replay lab | Trajectory replay, fault profiles, contract lab, certification, incident regression exist. [VERIFIED: `packages/testing/src/trajectory.ts`; `packages/testing/src/fault-profile.ts`; `packages/testing/README.md`] | Dataset-free suite composition, metric/rubric port, run-to-baseline comparison, CI report format. | Extend `@nifrajs/testing`. |
| Typed Agent App SDK | Versioned protocol and local RPC already exist. [VERIFIED: `packages/agent-protocol/src/index.ts`; `packages/coding-agent/src/rpc.ts`] | Transport client, reconnection/resume cursor, typed command facade, safe presentation view models. | New small `@nifrajs/agent-app` package after protocol additions. |
| Provider/model gateway | `AgentModelPort` and `NativeModelPort` are injected/provider neutral. [VERIFIED: `packages/agent/src/index.ts`; `packages/coding-agent/src/native.ts`] | Normalized model request/result contract, provider selection policy interface, retry/fallback evidence, structured-output parser boundary. | Extend `@nifrajs/agent`; provider SDK adapters stay optional packages. |
| Tool/MCP capability registry | Core tool catalog, MCP adapter, extension registry and capability manifests exist. [VERIFIED: `packages/mcp/src/tool-contract.ts`; `packages/coding-agent/src/extensions.ts`; `packages/coding-agent/src/capabilities.ts`] | Unified versioned descriptor, discovery snapshot, capability/approval policy attachment, adapter conformance profile. | Extend `@nifrajs/agent` plus `@nifrajs/mcp`; no new registry runtime. |
| Observability studio | Tool/MCP spans and Workbench timeline exist. [VERIFIED: `packages/agent-telemetry/src/index.ts`; `apps/workbench/README.md`] | Run/step IDs, counter/digest event model, causal graph projection, trace-to-replay links and UI views. | Extend telemetry + protocol + Workbench. |
| Human approval/handoff inbox | Approval manager, workflow `handoff`, approval RPC/UI exist. [VERIFIED: `packages/coding-agent/src/approvals.ts`; `packages/coding-agent/src/workflows.ts`; `packages/coding-agent/src/rpc.ts`] | Typed handoff lifecycle, assignee/expiry/resolution evidence, resumable waiting state, multi-client projection. | Extend local host/protocol; durable inbox is operated depth. |
| Durable agent jobs | `JobStore` has queue/lease/retry/dead-letter semantics. [VERIFIED: `packages/jobs/src/types.ts`; `packages/jobs/README.md`] | A run-dispatch adapter, plan/version/idempotency binding, cancellation lease semantics, run recovery. | Add `coding-agent/durable-jobs` adapter over public interfaces. |
| Deployment adapters | Agent protocol is backend-neutral and runner is Web-standard. [VERIFIED: `packages/agent-protocol/README.md`; `packages/runner/README.md`] | Adapter lifecycle/capability conformance contract and reference local/CI adapters. | Add a certification profile in `@nifrajs/testing`; adapters remain optional. |
| Workbench integration | Existing authenticated local UI consumes protocol/RPC. [VERIFIED: `apps/workbench/src/server.ts`] | Run DAG, eval comparison, registry inspection, approval/handoff queue, deployment status surfaces. | Extend Workbench only after SDK/protocol contracts are settled. |

## Public Seam vs Private Operated-Depth Verdict

| Capability | Public seam/reference implementation | Private operated layer | Boundary verdict |
|---|---|---|---|
| Control plane | `RunPlan`, scheduler/store/clock interfaces; deterministic in-process scheduler; evidence-only file/memory test store. | Durable scheduler, recovery workers, queues, retention, distributed locks. | SPLIT - operated durable state is private. [VERIFIED: `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`] |
| Evaluation/replay | Transcript hash, fault schedule, rubric interface, deterministic runner, aggregate-free reports. | Stored corpora, human labels, production outcomes, tuned prompts, fault/eval intelligence. | SPLIT - accumulated data is private. [VERIFIED: `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`] |
| Agent App SDK | Typed commands/events and fetch/SSE client over the public protocol. | Identity-aware client bootstrap, entitlement/session routing, remote relay. | SPLIT - identity/tenant state is private. [VERIFIED: `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`] |
| Model gateway | Provider-neutral `ModelGateway` port, request validation, fallback vocabulary, deterministic fake. | Credential vault, provider integrations, routing/pricing/cost enforcement. | SPLIT - credentials and economics are private. [VERIFIED: `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`] |
| Tool registry | Versioned descriptors, capability declarations, local snapshot, MCP/core adapters, certification. | Signed distribution, connector credentials, organization policy, hosted discovery. | SPLIT - external credentialed integration is private. [VERIFIED: `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`] |
| Observability | Counter/digest-only event schema, OpenTelemetry mapping, console/no-op exporter, local Workbench views. | Payload retention, tenant analytics, alerts, cost attribution and dashboards. | SPLIT - tenant data and retention are private. [VERIFIED: `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`] |
| Approval/handoff | Host-owned request/decision/handoff contracts, expiring-closed memory broker, local UI. | Shared inbox, identity, notifications, audit retention and escalation. | SPLIT - identity and operated state are private. [VERIFIED: `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`] |
| Durable jobs | `RunDispatchStore` and `JobStore` adapters plus memory/disposable test implementations. | Durable storage/queue/worker fleet and data policy. | SPLIT - durable state is private. [VERIFIED: `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`] |
| Deployment adapters | Adapter contract, capability matrix, disposable certification profile, local/CI adapters. | Managed deployment, secrets, remote execution and fleet controls. | SPLIT - operated execution and credentials are private. [VERIFIED: `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`] |

## Recommended Module Boundaries and Dependency Direction

```text
@nifrajs/agent-protocol  ←  @nifrajs/agent-app
             ↑            ←  @nifrajs/pi (adapter only)
             ↑            ←  @nifrajs/coding-agent  ← apps/workbench
@nifrajs/core ← @nifrajs/agent ← @nifrajs/testing
                     ↑    ↑
          @nifrajs/mcp ───┘    @nifrajs/agent-telemetry → @nifrajs/otel
@nifrajs/jobs ───────────────→ coding-agent durable-jobs adapter
```

1. **`@nifrajs/agent-protocol`** owns only versioned value contracts: `RunPlanRef`, `RunSnapshot`, `RunEvent`, `Handoff`, `EvidenceRef`, and opaque artifact references. It remains runtime- and payload-store-free. It must not import `core`, UI, jobs, MCP, provider, or storage packages. This preserves the current zero-dependency protocol design. [VERIFIED: `packages/agent-protocol/README.md`]
2. **`@nifrajs/agent`** owns generic in-process mechanics: model gateway port, structured-output parser port, capability registry composition, budget vector, and token-only run evidence. It can depend on existing core contracts but must not acquire a vendor SDK, database, UI, or durable store. [VERIFIED: `packages/agent/README.md`; `packages/agent/package.json`]
3. **`@nifrajs/coding-agent`** owns the local product coordinator: compile `RunPlan` to existing `WorkflowStep`, route subagents through `BoundedSubagentRunner`, expose an `OrchestrationHost`, and provide memory/file **evidence-only** adapters. Keep current `WorkflowRunner`; do not create `@nifrajs/orchestrator` yet.
4. **New `@nifrajs/agent-app`** owns a typed Agent App SDK: authentication supplied by the caller, `fetch`/SSE transport, event cursor/reconnect, command client, and presentation-safe view models. It depends only on `agent-protocol`; no host implementation, React, Tauri, Pi, provider SDK, or secret management.
5. **`@nifrajs/jobs`** remains generic. `coding-agent/durable-jobs` adapts a `RunDispatchStore` to `JobStore`; the generic queue must not import agent concepts.
6. **`@nifrajs/testing`** owns public deterministic eval composition and conformance profiles. It must produce only run IDs, hashes, invariant/rubric outcomes, counters, and fault tokens in public reference reports-not prompts, examples, outputs, tool args, or artifacts.
7. **`@nifrajs/agent-telemetry`** maps evidence-only lifecycle events to spans/metrics. It must reject accidental content attributes and allowlist dimensions.
8. **`@nifrajs/mcp`** continues to own MCP transport/tool adaptation. Registry projection goes from Nifra tool contracts → common descriptor → MCP, never the reverse.
9. **`apps/workbench`** depends on `agent-app` (and may retain a local launcher dependency on `coding-agent`), but production UI code should not import Pi/native internals or directly open session files. [VERIFIED: `apps/workbench/src/server.ts`]

## Architecture Pattern: Evidence/Artifact Split

```text
user request / model result / tool payload
            │
            ├── transient execution context ──> model/tool/backend
            │
            └── caller-owned artifact port (optional; never public reference sink)

run transition ──> evidence projector ──> id, hashes, counters, status, capability, timings
                                           │
                                           ├── protocol/SSE/Agent App SDK
                                           ├── telemetry/Workbench
                                           └── deterministic test report
```

This preserves the useful local event/replay model while satisfying the hard rule that the public reference implementation never becomes an accidental prompt, transcript, or model-output database. The current protocol permits `prompt`, `text`, `input`, `output`, and `report` fields in events, while `FileSessionStore` serializes a redacted/bounded `payload`; the expansion must introduce an evidence projection before new control-plane stores consume events. [VERIFIED: `packages/agent-protocol/src/index.ts:70-150`; `packages/coding-agent/src/sessions.ts:31-108`]

## Compatibility and Migration Hazards

| Hazard | Why it matters | Required mitigation |
|---|---|---|
| Protocol event payloads can contain prompts/text/tool inputs/outputs. [VERIFIED: `packages/agent-protocol/src/index.ts:70-150`] | Persisting or exporting those events would violate the public reference-sink boundary. | Add `projectEvidence(event)` and make every new store/exporter accept only `RunEvidence`; reject unknown payload fields. Keep raw event streaming in-process/transport-only unless a caller provides a private artifact port. |
| `FileSessionStore` writes payloads after redaction/bounding and host appends full events. [VERIFIED: `packages/coding-agent/src/sessions.ts:47-108`; `packages/coding-agent/src/host.ts:85-164`] | Secret-key redaction does not make arbitrary user/model text non-sensitive. | Do not extend this as the control-plane store. Add an explicit migration mode to write evidence-only records; retain legacy read support behind a user-owned local compatibility option and document non-hosted retention. |
| `AGENT_PROTOCOL_VERSION` is the literal `1`. [VERIFIED: `packages/agent-protocol/src/index.ts:9`] | A breaking event/snapshot change would split Pi, native backend, CLI, Workbench and replay fixtures. | Add additive optional fields and feature negotiation first; if semantics change, introduce protocol v2 adapter/dual decoder plus conformance fixtures before making v2 default. |
| Workflow steps are executable closures and values are `unknown`. [VERIFIED: `packages/coding-agent/src/workflows.ts:1-75`] | Closures cannot be persisted/distributed/recovered deterministically. | Introduce a serializable declarative `RunPlan` whose node handlers resolve through a registered `StepCatalog`; compile it to existing `WorkflowStep` locally. |
| Jobs are at-least-once leases. [VERIFIED: `packages/jobs/README.md`; `packages/jobs/src/types.ts`] | Agent tools can be side-effectful, so retrying a run can duplicate an effect. | Bind every durable node to a stable effect/idempotency key, pass existing tool idempotency support, and make recovery resume only at persisted safe boundaries. |
| Local process/runner/extension worker are not hostile-code sandboxes. [VERIFIED: `packages/agent/README.md`; `packages/runner/README.md`; `.planning/NIFRA-AGENT-SECURITY.md`] | An orchestrator increases the blast radius of untrusted extensions and agent tools. | Require OS-level isolation capability for untrusted code; public contracts may describe the requirement but may not pretend local adapters enforce it. |
| `coding-agent` currently has `@nifrajs/pi` as a dependency. [VERIFIED: `packages/coding-agent/package.json`] | New SDK/UI code could inadvertently retain backend-specific transitive coupling. | Make `agent-app` protocol-only; keep provider adapters leaf packages; test `agent-app` and Workbench client with replay/fake backend. |
| Workbench launcher starts a local Pi-backed RPC host. [VERIFIED: `apps/workbench/src/server.ts`] | UI evolution can accidentally couple new orchestration surfaces to Pi. | Run UI integration tests against a fake/replay backend and typed SDK; treat Pi only as one host launcher option. |

## Security and Privacy Invariants

1. **No public payload sink.** Public memory/file/no-op/reference stores, eval fixtures, telemetry exporters, snapshots, and benchmark outputs may retain only IDs, timestamps, hashes, bounded counters, capability names, status, error class/code, and schedule tokens. Never persist user/model/tool payloads, secrets, response bodies, prompts, raw diagnostics, or evaluation examples. [VERIFIED: `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`; `packages/testing/src/failure-lab.ts`; `packages/testing/src/incident.ts`]
2. **Parse every boundary.** RPC, plan manifests, capability declarations, provider responses, MCP inputs, and deployment adapter callbacks require schema parsing before use; casts are not authorization. Existing MCP tools validate before their handler and agent turns validate model output/tool admission. [VERIFIED: `packages/mcp/src/tool.ts`; `packages/agent/src/index.ts`]
3. **Host-owned authority.** A plan, workflow, subagent, extension, model, or UI extension cannot self-grant capability, approval, budget, workspace, or sandbox level. Approval expires denied; subagents only receive a ceiling. [VERIFIED: `packages/coding-agent/src/approvals.ts`; `packages/coding-agent/src/subagents.ts`; `.planning/NIFRA-AGENT-SECURITY.md`]
4. **Least privilege + monotonic delegation.** Child capabilities, budgets, deadlines, and workspace roots are subsets of the parent. New model providers/tools/deployment adapters must declare capabilities and require an approval path before activation.
5. **Strong local defaults.** Loopback-only RPC, bearer authentication, bounded bodies/events/context/output, filtered subprocess environment, redaction, transactional extension rollback, and no telemetry by default remain mandatory. [VERIFIED: `.planning/NIFRA-AGENT-SECURITY.md`; `packages/coding-agent/src/rpc.ts`; `packages/coding-agent/src/process.ts`]
6. **Durability is not authorization.** A durable adapter must enforce tenant/subject policy at its data layer in private operated depth; public seams must not encode identity, RLS, pricing, or credential policy. [VERIFIED: `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`]
7. **Safe externalization.** Any provider, mobile, or remote adapter is opt-in, uses short-lived authenticated credentials and explicit scopes, and has a no-network fake for test/replay. Remote pairing is not enabled by this public plan. [VERIFIED: `.planning/NIFRA-AGENT-SECURITY.md`]

## Test and Verification Strategy

| Layer | Required tests | Reuse |
|---|---|---|
| Protocol | Additive event/feature decoding, cursored stream resume, unknown-field rejection/forward compatibility, fake-backend conformance. | Existing bounded stream/protocol tests. [VERIFIED: `packages/agent-protocol/test/index.test.ts`] |
| Run-plan compiler | Compile plan → `WorkflowStep`; deterministic topological order; cycle/duplicate/missing dependency rejection; branch/parallel limit enforcement. | Existing workflow bounds tests. [VERIFIED: `packages/coding-agent/test/workflows.test.ts`] |
| Durable dispatch | Crash-before/after lease, duplicate delivery, expired lease, cancellation race, idempotency convergence and recovery from every safe boundary. | `JobStore` certification, failure lab, idempotency proof. [VERIFIED: `packages/jobs/test/certification.test.ts`; `packages/testing/src/failure-lab.ts`; `packages/testing/src/idempotency.ts`] |
| Gateway | Unknown provider response rejection, structured output parse failures, fallback only on declared retryable codes, deadline/budget monotonicity, no provider calls during replay. | Agent turn and trajectory tests. [VERIFIED: `packages/agent/test/agent.test.ts`; `packages/testing/src/trajectory.ts`] |
| Registry | Core-tool/MCP descriptor parity, schema/capability consistency, extension collision handling, certification profile for every adapter. | MCP typed-tool tests and extension tests. [VERIFIED: `packages/mcp/test/tool-contract.test.ts`; `packages/coding-agent/test/extensions.test.ts`] |
| Evaluations | Golden hash stability, fault-profile determinism, invariant/rubric reporting, baseline comparison on counters/outcomes only, zero payload serialization assertion. | Trajectory/fault-profile/incident tests. [VERIFIED: `packages/testing/test/trajectory.test.ts`; `packages/testing/test/fault-profile.test.ts`; `packages/testing/test/incident.test.ts`] |
| Security | Capability escalation denial, approval expiry closed, workspace/symlink escape rejection, no secret/payload in evidence/telemetry/bench snapshots, remote binding refusal by default. | Current agent surface/RPC/session tests. [VERIFIED: `packages/coding-agent/test/agent-surfaces.test.ts`; `packages/coding-agent/test/rpc.test.ts`; `packages/coding-agent/test/sessions.test.ts`] |
| Workbench / SDK | Replay-backed UI smoke, event ordering/deduplication, approval and handoff resolution, slow-consumer behavior, visual snapshots for owned shell surfaces. | Existing RPC/replay tests; add browser-level suite. [VERIFIED: `packages/coding-agent/test/native-replay.test.ts`; `apps/workbench/src/server.ts`] |
| Repository gates | `nifra check --json`, `nifra assure --json` when configured, `bun run check:agent-boundary`, isolated consumer matrix, size/cold-start checks, full release gate. | Required repository gates. [VERIFIED: `AGENTS.md`; `package.json`] |

### Evaluation Acceptance Contract

An evaluation case is `{caseId, planDigest, transcriptDigest?, faultSchedule, expectedInvariantIds, rubricOutcome}`. The public runner returns only outcome/counter/hash evidence. A caller may privately associate it with artifacts, labels, or raw trajectories, but that association is outside the public package. This composes directly with existing SHA-256 trajectory digests and schedule-token fault evidence. [VERIFIED: `packages/testing/src/trajectory.ts`; `packages/testing/src/failure-lab.ts`]

## Performance Budgets

These are phase gates, not promises. Measure on the reference machine and publish only payload-free summaries.

| Surface | Budget | Measurement |
|---|---|---|
| Existing local protocol event forwarding | Preserve bounded queue behavior; no unbounded backlog. | 100k event stress test and dropped-transient counter. [VERIFIED: `packages/agent-protocol/src/index.ts`; `packages/coding-agent/PERFORMANCE.md`] |
| Run-plan compile | p95 ≤ 10 ms for a 256-node plan; allocation bounded by plan size. | Deterministic benchmark with no provider/tool work. |
| Local scheduling | Dispatch overhead p95 ≤ 2 ms/node for no-op steps; parallelism must respect explicit cap. | Fake step catalog + injected clock. |
| Evidence projection | p95 ≤ 1 ms/event; max 4 KiB serialized evidence record; zero payload fields. | Property test + benchmark that rejects oversize/content keys. |
| Gateway | Added mediation overhead ≤ 5% over an injected fake model call; no hidden retry. | Compare direct fake port vs gateway; report counters only. |
| Replay/eval | 1,000-step deterministic replay ≤ 250 ms excluding user code; no network or real tool execution. | Existing dry-run trajectory semantics. [VERIFIED: `packages/testing/src/trajectory.ts`] |
| Workbench | p95 evidence-event-to-render ≤ 16 ms; initial orchestration view usable ≤ 1 s after local RPC ready; virtualize histories beyond 1,000 rows. | Replay backend browser benchmark. |
| Memory | Keep agent app SDK dependency-free/low allocation; local coordinator stores a bounded live window; every durable history is adapter-owned. | Heap/RSS soak at 1k/10k/100k evidence events. |

Do not optimize by retaining raw payloads for debug. Content-free evidence plus caller-owned artifacts is the required observability design.

## Dependency-Ordered Implementation Phases

### Phase 0 - Boundary lock and migration tests

- Add public “evidence vs artifact” types and forbidden-payload serialization tests.
- Audit `FileSessionStore`, host event appends, replay fixtures, telemetry and benchmarks; prevent any new public reference store from accepting raw event payloads.
- Freeze current protocol v1 fixtures and establish fake/replay conformance clients.
- Exit: property tests prove every public reference record is payload-free; protected framework packages retain no agent product import.

### Phase 1 - Run-plan and local orchestration host

- Add serializable `RunPlan`/node/dependency/budget/handoff contracts, a `StepCatalog`, and compiler to existing `WorkflowStep`.
- Add `OrchestrationHost` in `coding-agent`, dispatching tasks through existing workflow/subagent/approval/verification components.
- Add evidence-only memory/file adapters and deterministic run recovery simulation; retain legacy local session compatibility separately.
- Exit: planner → implementer → verifier fixture runs with bounded parallelism, cancellation, checkpoint and approval, using no provider-specific code.

### Phase 2 - Protocol lifecycle and typed Agent App SDK

- Add additive run/handoff/evidence event projections and cursor semantics to protocol; negotiate features rather than breaking v1.
- Create `@nifrajs/agent-app` with typed RPC/SSE command facade, event dedupe/resume, cancellation and presentation-safe view models.
- Refactor Workbench browser client to consume the SDK and test against replay/fake backends.
- Exit: CLI, Workbench, and a minimal SDK fixture invoke the same run and observe the same evidence stream without importing Pi.

### Phase 3 - Registry, capability policy and approvals/handoff

- Normalize Nifra tool catalog, MCP descriptors, extension tools, and deployment adapter descriptors into a versioned descriptor snapshot.
- Attach capability requirements, schema digests, approval policy, idempotency/retry annotations, and certification requirements.
- Extend approval to typed handoff lifecycle-offered, assigned, resolved, expired-without granting plan-defined authority.
- Exit: capability escalation, descriptor drift, expired approval and unknown handoff states fail closed.

### Phase 4 - Model gateway and deployment adapters

- Introduce a generic gateway port in `@nifrajs/agent`: validated request, structured response, error taxonomy, deadline/cost envelope and evidence-only fallback record.
- Move each actual provider integration to a leaf optional package; retain Pi as a backend adapter, not the gateway default.
- Add local process, CI, and replay deployment adapter profiles; certify adapters in disposable fixtures.
- Exit: fake provider, replay provider and one optional adapter pass the same gateway/conformance suite; no model credentials in public code paths.

### Phase 5 - Durable jobs and recovery

- Define `RunDispatchStore`/`RunLease`/checkpoint interfaces; adapt public `JobStore` for a local/disposable implementation.
- Implement idempotent node keys, lease expiry recovery, cancellation, dead-letter evidence and replayable recovery schedules.
- Leave durable multi-worker stores and retention as private operated-layer implementations.
- Exit: failure lab proves convergence under duplicate delivery, crash-after-checkpoint and retry; public reports retain only evidence.

### Phase 6 - Evaluation/replay lab and observability studio

- Add eval suite/rubric/baseline APIs to `@nifrajs/testing`, composed from trajectory, failure, contract and adapter labs.
- Extend telemetry with run/plan/node correlation, safe counters/digests and trace links; no content attributes.
- Add Workbench run graph, evidence timeline, trace-to-replay link, eval comparison and fault-injection views.
- Exit: CI can reject an invariant/rubric regression deterministically and Workbench can inspect the exact evidence without raw payload persistence.

### Phase 7 - Release hardening and optional operated adapters

- Run protocol compatibility, package boundary, cross-runtime, consumer, size/cold-start, accessibility/visual, security and release-equivalent gates.
- Publish migration guides for v1 clients and legacy local session logs; keep deployment/provider/operated adapters separately installable.
- Exit: public local-first platform is usable without hosted state, provider SDKs, or private operated depth.

## Major Risks and Anti-Features

| Risk / anti-feature | Decision |
|---|---|
| A second orchestration engine or renamed `WorkflowRunner` package | Do not build it. Compile declarative plans to the existing runner first. |
| Public durable database/queue/session service | Do not build it. Publish interfaces and disposable/in-memory/evidence-only references only. |
| Public prompt/transcript/eval corpus sink | Prohibited. It crosses both privacy and accumulated-data boundaries. |
| “Exactly once” claims over jobs/tools | Prohibited. Use at-least-once leases + idempotent effects + evidence. |
| Provider mega-SDK in the kernel | Do not add. Keep injected ports and optional leaf adapters. |
| An LLM choosing its own approval/capability/budget | Prohibited. Host policy is authoritative and monotonic. |
| Treating local process/runner/extension worker as a sandbox | Prohibited. Require explicit OS isolation for untrusted code. |
| Remote/mobile execution by default | Deferred. Mobile/remote is a scoped client/approval surface only after transport/auth design is complete. |
| Workbench directly reading host session files or importing backend internals | Prohibited. Use typed Agent App SDK/RPC projections. |
| Persisting runnable closures in plans | Prohibited. Plans are declarative; handler resolution is local and registered. |

## Open Decisions and Recommended Defaults

| Decision | Recommendation | Why |
|---|---|---|
| Where should `RunPlan` live? | Start in `@nifrajs/agent-protocol` as pure value contracts; compilation remains in `coding-agent`. | It is shared by clients/backends without importing runtime code. |
| New package for orchestration? | No for the first implementation. Use `coding-agent/orchestration`; extract only when a non-coding-agent consumer needs it. | Existing workflow/subagent/approval composition already lives there. |
| New package for Agent App SDK? | Yes: `@nifrajs/agent-app`, protocol-only. | A network/client runtime does not belong in the zero-dependency protocol or host package. |
| Payload handling in local sessions? | Make new control-plane/eval stores evidence-only; offer a caller-owned artifact port for explicitly chosen local/private retention. | Prevents accidental public reference-sink expansion while preserving local product flexibility. |
| Protocol evolution | Add feature negotiation plus additive v1 fields now; defer v2 until a semantic incompatibility is demonstrated. | Pi/CLI/Workbench/replay currently share v1. |
| Scheduling semantics | At-least-once node dispatch with stable idempotency keys. | Matches current job-store lease model and real distributed failure conditions. |
| Provider fallback policy | Caller-provided, explicit retryable error codes and budget ceiling; never silently change model/provider. | Protects cost, quality and compliance decisions. |
| Evaluation assertions | Contract/invariant/rubric outcomes plus counters/hashes; no opaque “agent score” as a release gate. | Deterministic existing testing substrate supports auditable gates. |
| Workbench priority | Build run graph + approval/handoff + replay evidence first; postpone rich provider management. | It proves the platform seam without exposing credentials or adding backend coupling. |
| Durable private operated layer timing | Start only after Phase 5 contracts and failure tests stabilize. | Durable state is expensive to migrate and must not dictate the public API prematurely. |

## Sources

### Primary - current codebase (HIGH confidence)

- `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md` - public/private decision rule and red lines.
- `AGENTS.md` - dependency isolation, trust-boundary parsing, verification and release gates.
- `.planning/NIFRA-AGENT-WORKBENCH-PLAN.md` - locked local-first and backend-neutral product direction.
- `.planning/NIFRA-AGENT-SECURITY.md` - agent trust boundaries and current limitations.
- `packages/agent*`, `packages/coding-agent`, `packages/pi`, `packages/testing`, `packages/mcp`, `packages/jobs`, `packages/runner`, and `apps/workbench` READMEs, manifests, source, and tests listed in the inventory.

## Confidence and Gaps

- **Current capability inventory: HIGH.** It is based on direct reads of package documentation, manifests, source modules and tests in this session.
- **Boundary verdicts: HIGH.** They follow the project’s explicit public/private rubric.
- **Package boundaries and phasing: MEDIUM.** They are implementation recommendations derived from the observed dependency graph and require product-owner confirmation before being locked.
- **Performance budgets: MEDIUM.** They are proposed phase gates; hardware measurements must validate them before release.

### What might be missing

The repository contains the public local-first agent implementation; no private operated implementation was inspected or assumed. Therefore, exact deployed retention, tenant identity, connector, and provider-routing requirements remain intentionally unspecified and must be decided outside this public plan.
