# Nifra Agent Platform Program Plan

**Status:** Execution-ready program plan
**Roadmap:** `.planning/agent-platform/ROADMAP.md`
**Requirements:** `.planning/agent-platform/REQUIREMENTS.md`
**Research:** `.planning/agent-platform/RESEARCH.md`
**Program shape:** 8 dependency-ordered vertical phases, 24 bounded tasks, 88 mapped requirements

## Executive decision

Build an agent platform on Nifra by extending the systems that already exist, not by renaming or duplicating them.

The local orchestration control plane lives in `@nifrajs/coding-agent/orchestration`. A serializable `RunPlan` is parsed and compiled into the existing `WorkflowRunner`; registered step keys resolve through a host-owned `StepCatalog`. `BoundedSubagentRunner`, `ApprovalManager`, verification, checkpoints, replay, jobs leases, failure lab, and adapter certification remain their canonical mechanisms.

Extend `@nifrajs/testing` into the deterministic agent eval lab. Create one new public package, `@nifrajs/agent-app`, as a protocol-only Web client. Extend protocol version 1 additively and negotiate features. Keep all public reference persistence and reporting evidence-only. Private operated implementations may satisfy public ports, but public Nifra does not implement durable multi-tenant state, credentials, retention, pricing, notifications, remote fleets, or accumulated eval intelligence.

The first shipped slice is a production tracer: one declarative node is parsed, compiled, executed by the real workflow runner, projected into bounded evidence, exposed as a negotiated protocol feature, consumed by a fake client, and checked by a deterministic eval invariant. Expansion is blocked until that slice passes privacy, compatibility, and boundary gates.

## Non-goals

- No initial `@nifrajs/orchestrator` package.
- No second workflow, DAG, approval, subagent, replay, failure, jobs, or certification engine.
- No public durable database, queue service, scheduler service, tenant store, RLS implementation, retention service, or remote worker fleet.
- No public provider credentials, credential vault, pricing, billing, entitlements, or spend enforcement.
- No public payload-persisting reference sink for prompts, model text, tool inputs or outputs, bodies, secrets, diagnostics, examples, artifacts, or corpora.
- No exactly-once claims. Dispatch is at least once and effects converge through stable idempotency keys.
- No claim that local process, runner, replay, or extension worker isolates hostile code.
- No production Workbench dependency on Pi, native backend internals, host session files, or private operated APIs.
- No remote or mobile transport, notifications, Tauri release, signed desktop artifacts, or OS sandbox implementation in this program.

## Mandatory execution preflight and concurrent-change safety

This repository may already contain user or concurrent-agent changes. Before any phase and before every task, the executor must treat the current worktree as shared:

1. Record the current commit, every dirty or untracked path from `git status --porcelain=v2 -z --untracked-files=all`, and a SHA-256 digest for each existing dirty file. Store the baseline under the repository git directory, not in the worktree, and never stage or commit it.
2. Select the active task's explicit `Write allowlist` below. The phase allowlist is the union of its three task allowlists. A task may read any required project context, but it may modify, generate, stage, commit, or report ownership only for paths in its active allowlist.
3. If an allowlisted path is already dirty and its digest is not the recorded output of an earlier completed agent-platform task, stop before writing and escalate the overlap. Never overwrite, restore, format, stage, or commit that path on an assumption about ownership.
4. After each mutation and before each commit, compare changed and staged paths with the active allowlist. Any path outside it is blocking. Stage with `git add -- <exact changed allowlisted paths>` only; `git add .` and `git add -A` are forbidden for this program.
5. Preserve all baseline paths outside the active allowlist byte-for-byte and leave them unstaged. The task report lists only allowlisted paths changed by the task and separately states that unrelated baseline paths were preserved.
6. P7 generated documentation and corpus work runs first in an isolated clean linked worktree at the committed program head. Apply its path-scoped patch back only after the main-worktree overlap guard confirms every generated target is unchanged from baseline. P7 release verification runs in a fresh clean linked worktree and never uses the dirty shared worktree as release evidence.

P0-T3 introduces `scripts/check-agent-platform-worktree.ts` and the root `check:agent-platform-worktree` command to mechanize steps 1 through 5 for every later task. P0-T1 through P0-T3 use the same rules with direct read-only Git status and digest commands before that helper exists. Negative fixtures cover an unrelated dirty path, an overlapping dirty target, an out-of-allowlist mutation, and an out-of-allowlist staged path.

## Current surface inventory and canonical ownership

| Surface | Canonical owner now | Program use | Duplicate implementation forbidden |
| --- | --- | --- | --- |
| Session and event wire values | `@nifrajs/agent-protocol` | Add evidence, run, handoff, feature, and cursor values only | Runtime, provider, store, UI, and scheduler code |
| Provider-neutral agent turns and tool policy | `@nifrajs/agent` | Add gateway, registry, budget, and deployment value or policy contracts | Provider SDKs, credentials, durable state |
| Workflow execution | `WorkflowRunner` in `packages/coding-agent/src/workflows.ts` | Compile declarative nodes into current `WorkflowStep` values | A new executor or public orchestrator package |
| Subagent limits | `BoundedSubagentRunner` | Resolve declarative subagent nodes under monotonic ceilings | A second child runner |
| Approval broker | `ApprovalManager` | Extend with matching handoff and expiry evidence | UI-owned or model-owned authority |
| Local host and RPC | `CodingAgentHost`, `CodingAgentRpcServer` | Add orchestration lifecycle and feature-negotiated commands | A second daemon or private API |
| Pi and native execution | `@nifrajs/pi`, `NifraBackend` | Leaf backend choices behind protocol and gateway seams | Pi-specific SDK or UI contracts |
| Deterministic replay | `ReplayBackend`, agent trajectory replay | Feed conformance, evals, and Workbench fixtures | A new replay engine |
| Failure injection | `@nifrajs/testing` failure lab and fault profiles | Add agent failure schedules and regression reports | A second fault scheduler |
| Adapter certification | `@nifrajs/testing/certification` | Add registry, gateway, dispatch, and deployment profiles | Package-specific certification frameworks |
| Typed MCP tools | `@nifrajs/mcp` | Project descriptors into common registry | Moving invocation or transport ownership |
| At-least-once queue leases | `@nifrajs/jobs` | Coding-agent adapter maps run dispatch to `JobStore` | Agent types inside jobs or exactly-once claims |
| Structured request runner | `@nifrajs/runner` | Deployment conformance fixture only | Hostile-code sandbox claims |
| Tool telemetry | `@nifrajs/agent-telemetry` | Add safe run correlation and allowlisted counters | Payload tracing or tenant analytics |
| Browser shell | `apps/workbench` | Consume Agent App SDK view models and replay fixtures | Host or backend logic in production UI |

## Target dependency graph and module placement

```text
packages/agent-protocol
  src/evidence.ts              RunEvidence, EvidenceRef, ArtifactRef, projector parser
  src/run-plan.ts              RunPlan and RunPlanRef pure values
  src/run-lifecycle.ts         RunSnapshot, RunEvidenceEvent, HandoffSnapshot, feature/cursor values
  src/index.ts                 additive protocol version 1 exports
           |
           +-----------------------> packages/agent-app
           |                           src/client.ts
           |                           src/transport.ts
           |                           src/view-models.ts
           |                           src/index.ts
           |
           +-----------------------> packages/coding-agent
                                       src/orchestration/compiler.ts
                                       src/orchestration/catalog.ts
                                       src/orchestration/host.ts
                                       src/orchestration/evidence-store.ts
                                       src/orchestration/dispatch.ts
                                       src/orchestration/durable-jobs.ts ----> packages/jobs
                                       src/orchestration/index.ts
                                               |
                                               +----> existing workflows.ts
                                               +----> existing subagents.ts
                                               +----> existing approvals.ts
                                               +----> existing verification.ts

packages/core/tool-contract ----> packages/agent/src/registry.ts
packages/agent
  src/registry.ts                common descriptors and host policy composition
  src/gateway.ts                 provider-neutral model gateway
  src/deployment.ts              deployment lifecycle and capability contracts
        ^                              ^
        |                              |
packages/mcp/src/agent-descriptor.ts   packages/coding-agent/src/deployment-adapters.ts
        |                              |
        +------------------------------+------> packages/testing
                                                  src/agent-eval.ts
                                                  src/agent-certification.ts

packages/agent-telemetry/src/index.ts ----> evidence-safe spans and metrics

apps/workbench
  src/server.ts                  local launcher may depend on coding-agent; serves dist/public
  src/browser.ts                 typed production browser entrypoint importing agent-app
  scripts/build-assets.ts        browser bundle plus static asset copier
  dist/public/app.js             emitted browser bundle with no bare workspace import
  public/index.html              source template for run graph, inbox, timeline, eval views
```

Dependency rules:

1. `agent-protocol` remains dependency-free and contains only parseable value contracts.
2. `agent-app` depends only on `agent-protocol` and Web platform APIs.
3. `agent` keeps its current core dependency but gains no provider, jobs, UI, storage, or desktop dependency.
4. The optional `@nifrajs/mcp/agent-descriptor` subpath declares `@nifrajs/agent` as an optional peer plus development dependency; MCP transport and execution do not move, and `agent` never imports MCP.
5. `coding-agent` declares direct workspace dependencies on `agent` for its registry projection and on `jobs` when the durable-jobs adapter lands. `jobs` and `agent` never depend on coding-agent; durable jobs remain reachable through `@nifrajs/coding-agent/orchestration`.
6. `testing` composes the existing agent, MCP, failure, trajectory, idempotency, and certification surfaces.
7. Workbench declares `@nifrajs/agent-app` and `@nifrajs/coding-agent` workspace dependencies. Its typed browser entrypoint imports Agent App SDK only, is bundled to `dist/public/app.js`, and is served from that built path; its local launcher may construct a coding-agent host.
8. Protected framework packages do not import any agent-platform package.

## Evidence and artifact data contract

### Evidence allowlist

Every new public reference store, reporter, exporter, benchmark, snapshot, dead-letter record, eval result, and Workbench data source accepts a parsed `RunEvidence` value. Allowed value classes are:

| Class | Examples | Bound |
| --- | --- | --- |
| Identity | `runId`, `planId`, `nodeId`, `attemptId`, `eventId`, `approvalId`, `handoffId` | Non-empty bounded strings; opaque to the framework |
| Time | `at`, `startedAt`, `completedAt`, `expiresAt`, `durationMs` | Finite integers; no locale-formatted text |
| Digest | `planDigest`, `evidenceDigest`, `schemaDigest`, `artifactDigest`, `transcriptDigest` | Algorithm-tagged bounded digest strings |
| Counter | attempts, tokens, bytes, dropped events, nodes, tool calls | Non-negative safe integers with per-field ceilings |
| Policy name | capability, status, lifecycle state, retry class, isolation class | Closed enums or bounded registered names |
| Error evidence | stable `code`, retryable flag, terminal status | No messages, stacks, diagnostics, or raw provider values |
| Schedule evidence | cursor, sequence, lease token, fault schedule token, idempotency key | Opaque bounded tokens |
| Reference | `EvidenceRef`, `ArtifactRef`, `ReplayRef`, `TraceRef` | Opaque ID plus optional digest and media kind; no content |

Serialized evidence records are capped at 4 KiB. Arrays and maps have explicit item limits. Unknown keys fail closed at sink boundaries even when protocol decoders otherwise tolerate additive fields.

### Forbidden-field policy

The shared rejection corpus includes case and separator variants of: `prompt`, `messageText`, `text`, `input`, `output`, `arguments`, `body`, `response`, `secret`, `tokenValue`, `credential`, `diagnostic`, `stack`, `example`, `artifact`, `content`, `transcript`, `completion`, `reasoning`, and arbitrary unknown nested keys. A forbidden value may exist transiently inside an existing live protocol event for legacy behavior, but it must pass through `projectEvidence` before any new store, reporter, exporter, telemetry attribute, eval result, benchmark, or Workbench orchestration view consumes it.

Hashes do not permit storing their source content. Debug usefulness never overrides this boundary.

### Caller-owned artifact port

`ArtifactPort` is optional and injected. It may accept or return caller-defined content under caller policy, but public reference implementations supply no payload-persisting artifact port. Platform code stores only the opaque `ArtifactRef`. Absence of a port is a supported configuration; a node requiring an artifact operation fails with `artifact_port_unavailable` before side effects.

### Private operated implementation obligations

A private adapter may persist content only under its own tenant, RLS, encryption, retention, and authorization policy. Those details do not enter public package types except as opaque adapter configuration owned by the caller.

### Enforceable operated-depth deny policy

`scripts/check-public-boundary.ts` must enforce two independent layers:

1. A generic agent-platform policy, active in every local and CI run, inventories public runtime implementations and exports. Every exported `Store`, `Scheduler`, `Adapter`, `Reporter`, `Registry`, `Vault`, or similarly stateful implementation under the agent-platform package roots must be declared in `scripts/public-agent-reference-allowlist.json` as `memory`, `local-file`, `noop`, `fake`, `replay`, or `ci`, name its public port, and pass the evidence-only and disposable-reference checks. Unknown implementations, undeclared runtime exports, operated classifications, prohibited runtime dependency edges, and implementation indicators for tenant or RLS state, credential vaults, pricing or spend, retained corpora, notifications, hosted discovery, managed deployment, or remote fleets fail even when `PRIVATE_MARKERS` is unset. Pure interfaces and opaque private-adapter handoff types are classified separately and cannot register runtime implementations.
2. The existing private-name marker scan remains additive. Local non-CI runs may omit the secret markers while still running the generic policy. When `CI=1` or release mode is requested, an empty `PRIVATE_MARKERS` value is a hard failure before scanning. CI and release environments must supply the non-empty secret; private names are never checked into the public repository.

`scripts/check-public-boundary.test.ts` adds four fixtures: an allowed disposable memory adapter, an undeclared generic durable or tenant-backed implementation with no private marker, CI with marker configuration absent, and a file containing a configured sentinel marker. P0 cannot close until all four behave as expected. P7-T3 re-runs the generic policy and asserts non-empty marker configuration before `check:release` in the clean release worktree.

## Protocol version 1 compatibility and legacy session migration

### Protocol compatibility plan

1. Freeze golden fixtures for current snapshots, events, fake backend, replay backend, Pi translation, RPC, and Workbench behavior before adding fields.
2. Keep `AGENT_PROTOCOL_VERSION` equal to `1`.
3. Add optional `features` and additive run, evidence, cursor, registry, eval, approval, and handoff values. Feature names are negotiated before commands are sent.
4. New client to old host: legacy commands work; new commands return `feature_unsupported` without transport failure.
5. Old client to new host: legacy fields and events retain meaning; new optional fields are ignored.
6. New client to new host: the feature intersection controls commands and stream projections.
7. A stale cursor returns `resync_required` with the current snapshot reference; the SDK never guesses across a gap.
8. A future protocol major requires a recorded semantic incompatibility, a dual decoder, cross-version fixtures, migration documentation, and explicit product-owner approval. This program does not authorize it.

### `FileSessionStore` migration plan

- Keep legacy read and explicit local compatibility behavior because current CLI, RPC, and Workbench users may own JSONL history.
- Do not extend `FileSessionStore` into the orchestration run store and do not make it an input to telemetry, eval, or Workbench orchestration views.
- Add a separate evidence-only store and a migration command or library operation that reads legacy local records transiently, projects safe evidence, and writes to a new target directory. The source directory is never modified.
- Preserve session ID, sequence, timestamp, known event type or stable replacement code, and safe counters. Drop content. An optional digest may be computed transiently without retaining source bytes.
- Emit a migration report containing record counts, skipped counts by stable code, first and last sequence, and output digest only.
- Validate the complete output before switching a local configuration pointer. Rollback points the local host back to the untouched legacy directory.
- Document that legacy logs can contain sensitive local content and are never an acceptable hosted or shared control-plane store.

## Phase execution waves and safe parallelism

| Wave | Phase | Depends on | Safe parallel work | Shared-file rule |
| ---: | --- | --- | --- | --- |
| 0 | P0 Evidence-safe tracer | Existing green baseline | None; tracer must establish contracts | One executor owns protocol and tracer contracts |
| 1 | P1 Orchestration plus eval | P0 | May run beside P2 after P0 | P1 owns coding-agent orchestration and testing eval files |
| 1 | P2 Agent App SDK and Workbench cutover | P0 | May run beside P1 after protocol tracer fields freeze | P2 owns protocol lifecycle files, new package, and Workbench files |
| 2 | P3 Registry, policy, and HITL | P1, P2 | Registry adapters and inbox UI may split after lifecycle contracts land | Shared indices merge only in the phase integration task |
| 3 | P4 Gateway and deployment | P3 | Gateway and deployment tasks are file-disjoint until certification | Testing export integration is serialized last |
| 4 | P5 Jobs and recovery | P4 | Recovery tests may be prepared while dispatch contracts land | Durable-jobs adapter alone owns the coding-agent to jobs edge |
| 5 | P6 Eval and observability studio | P2, P3, P5 | Eval CI and telemetry may run in parallel; UI waits on their view models | Workbench files have one owner |
| 6 | P7 Compatibility and release | P1 through P6 | Documentation and migration fixtures may run in parallel before final gate | Root scripts and generated corpus have one release owner |

## Explicit sequencing rules

1. Baseline fixtures and the phase-0 failing tracer test land before production tracer code.
2. Evidence projection lands before any new store, exporter, reporter, benchmark, eval report, telemetry mapping, or UI view.
3. `RunPlan` parsing and graph validation occur before catalog lookup; catalog lookup occurs before authority admission; authority admission occurs before side effects.
4. The compiler targets `WorkflowStep`; changes to `WorkflowRunner` are limited to defects or additive hooks proven by tracer tests.
5. Eval contracts land with the tracer and expand with orchestration. Orchestration phases cannot close without deterministic eval evidence.
6. Agent App SDK conformance against fake and replay precedes Workbench cutover.
7. Registry and host policy precede gateway routes, deployment adapters, and durable dispatch activation.
8. Idempotency keys are stable before retries or lease recovery are enabled.
9. Telemetry and Workbench observability consume recovery evidence only after the recovery state machine passes fault injection.
10. Compatibility, migration, docs, consumer, performance, and release gates run after public surfaces freeze.
11. No phase may add a provider SDK, payload sink, operated store, tenant identity, RLS implementation, pricing, or private product topology.
12. No `@nifrajs/orchestrator` directory or manifest is created unless Phase 7 records both extraction prerequisites as already satisfied.

## Root command provenance

Every `bun run <name>` command in this plan is either present in the current root `package.json` or is introduced before first later use:

| Root command | Provenance |
| --- | --- |
| `test`, `build`, `check:agent-boundary`, `check:agent-isolation`, `check:public-boundary`, `check:consumers` | Present before this program |
| `bench:agent`, `check:size`, `check:cold-start`, `check:coverage`, `check:changesets`, `check:release` | Present before this program |
| `gen:llms`, `gen:api`, `gen:node-outcome`, `gen:public`, `check:corpus`, `check:public-manifest`, `check:docs` | Present before this program |
| `bench:agent-platform` | Added by P0-T3 together with `scripts/bench-agent-platform.ts`; P0-T3's own verification runs it only after creation |
| `check:agent-platform-plan` | Added by P0-T3 together with `scripts/check-agent-platform-plan.ts`; later phase and final gates use it only after P0-T3 |
| `check:agent-platform-worktree` | Added by P0-T3 together with `scripts/check-agent-platform-worktree.ts`; P1 through P7 use it after P0-T3 |
| `check:public-boundary:release` | Added by P0-T3 as the fail-closed release wrapper; it requires non-empty `PRIVATE_MARKERS` before invoking the existing boundary check |
| `check:workbench-agent` | Added by P6-T3 to the root `package.json` as `"check:workbench-agent": "bun run scripts/bench-workbench-agent.ts --check"` together with `scripts/bench-workbench-agent.ts`; P6-T3 and later gates use it only after creation |

`bun run --filter '<package>' build` uses each package's existing `build` script, except `@nifrajs/agent-app`, whose manifest and build script are created in P2-T2 before any later filtered build. P2-T3 replaces the existing Workbench `build` script before verifying its browser and server outputs. `nifra check --json` and conditional `nifra assure --json` are existing workspace CLI surfaces documented in `AGENTS.md`; they are not root package scripts.

## Phase task plans

### Phase 0 tasks: Evidence-safe declarative tracer

**Requirement coverage:** BND-01, BND-02, BND-03, BND-04, BND-05, BND-06, BND-07, BND-08, ORC-01, ORC-02, ORC-03, APS-01, EVL-01, EVL-02, QLT-01

#### Task P0-T1: End-to-end declarative run tracer

**Requirement IDs:** ORC-01, ORC-02, ORC-03, APS-01, EVL-01, EVL-02
**Write allowlist:** `packages/agent-protocol/src/run-plan.ts`, `packages/agent-protocol/src/evidence.ts`, `packages/agent-protocol/src/index.ts`, `packages/agent-protocol/test/index.test.ts`, `packages/agent-protocol/test/run-plan.test.ts`, `packages/coding-agent/src/orchestration/**`, `packages/coding-agent/test/orchestration-tracer.test.ts`, `packages/testing/src/agent-eval.ts`, `packages/testing/src/index.ts`, `packages/testing/test/agent-eval-tracer.test.ts`

<read_first>

- `packages/agent-protocol/src/index.ts`
- `packages/coding-agent/src/workflows.ts`
- `packages/testing/src/trajectory.ts`
- `packages/coding-agent/test/workflows.test.ts`
- `packages/agent-protocol/test/index.test.ts`

</read_first>

<action>

Create the leading production tracer for ORC-01, ORC-02, ORC-03, APS-01, EVL-01, and EVL-02. Add pure `RunPlan` and evidence contracts in `packages/agent-protocol/src/run-plan.ts` and `packages/agent-protocol/src/evidence.ts`; add `packages/coding-agent/src/orchestration/index.ts` with a one-node `StepCatalog`, parser, graph validator, compiler to `WorkflowStep`, and `projectEvidence`; add `packages/testing/src/agent-eval.ts` with the bounded tracer invariant. Start with `packages/coding-agent/test/orchestration-tracer.test.ts` failing. The test must parse a real plan, resolve a fake registered step, execute through `WorkflowRunner`, project accepted, started, completed, and verified transitions, negotiate the feature, and assert a stable eval digest. Use no provider, Pi, model call, new executor, raw payload store, or runnable closure in the plan.

</action>

<acceptance_criteria>

- A one-node plan round-trips as data, rejects cycles and unknown step keys, and executes through the existing runner.
- Repeated execution with the same injected clock and IDs produces the same terminal evidence digest.
- The eval report contains only IDs, digests, status codes, counters, and invariant results.
- Legacy protocol version and required field meanings are unchanged.

</acceptance_criteria>

<verify>

- `bun test packages/coding-agent/test/orchestration-tracer.test.ts packages/agent-protocol/test/index.test.ts packages/testing/test/agent-eval-tracer.test.ts`
- `bun run --filter '@nifrajs/agent-protocol' --filter '@nifrajs/coding-agent' --filter '@nifrajs/testing' build`

</verify>

#### Task P0-T2: Evidence firewall, artifact seam, and authority invariants

**Requirement IDs:** BND-01, BND-02, BND-03, BND-04, BND-05, BND-06, BND-07, BND-08
**Write allowlist:** `packages/agent-protocol/src/evidence.ts`, `packages/agent-protocol/test/evidence.test.ts`, `packages/coding-agent/src/orchestration/index.ts`, `packages/coding-agent/src/orchestration/policy.ts`, `packages/coding-agent/test/orchestration-policy.test.ts`, `packages/agent/src/execution-policy.ts`, `packages/agent/test/execution-policy.test.ts`, `scripts/check-public-boundary.ts`, `scripts/check-public-boundary.test.ts`, `scripts/public-agent-reference-allowlist.json`

<read_first>

- `packages/coding-agent/src/sessions.ts`
- `packages/coding-agent/src/host.ts`
- `packages/agent/src/execution-policy.ts`
- `.planning/NIFRA-AGENT-SECURITY.md`
- `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`

</read_first>

<action>

Implement BND-01 through BND-08. Add strict evidence parsing, 4 KiB serialization cap, bounded collections, the shared forbidden-field corpus, `ArtifactPort`, and monotonic authority-vector validation. New reference adapters must accept parsed evidence only. Add explicit adapter limitation metadata so local process, runner, replay, and extension worker cannot certify hostile-code isolation. Extend `scripts/check-public-boundary.ts` with the generic operated-depth policy defined above and `scripts/public-agent-reference-allowlist.json`; this structural policy always runs and cannot depend on `PRIVATE_MARKERS`. Keep the marker scan additive, but make `CI=1` and explicit release mode fail before scanning when marker configuration is empty. Add negative fixtures for an undeclared operated implementation with markers unset, missing CI marker configuration, and a configured sentinel marker, plus a passing disposable memory reference fixture. Do not change the user's concurrent edits in `packages/agent/src/execution-policy.ts`; the executor must run the overlap guard, merge against its then-current API, and preserve unrelated work.

</action>

<acceptance_criteria>

- Property tests accept all evidence allowlist classes and reject forbidden, unknown nested, oversized, non-finite, and unbounded values.
- The system runs with no artifact port; artifact-required work stops before effects with `artifact_port_unavailable`.
- Child capability, budget, deadline, workspace, and isolation vectors never exceed the parent.
- Public-boundary tests find no operated-depth names or implementations.
- Generic operated-depth fixtures fail without marker assistance, CI fails closed when markers are absent, a sentinel marker is detected, and an allowlisted disposable reference passes.

</acceptance_criteria>

<verify>

- `bun test packages/agent-protocol/test/evidence.test.ts packages/coding-agent/test/orchestration-policy.test.ts packages/agent/test/execution-policy.test.ts`
- `bun test scripts/check-public-boundary.test.ts`
- `CI=1 PRIVATE_MARKERS=__nifra_boundary_fixture_marker__ bun run check:public-boundary && bun run check:agent-boundary && bun run check:agent-isolation`

</verify>

#### Task P0-T3: Freeze compatibility and package reachability

**Requirement IDs:** QLT-01
**Write allowlist:** `package.json`, `packages/agent-protocol/package.json`, `packages/coding-agent/package.json`, `packages/testing/package.json`, `packages/agent-protocol/test/fixtures/**`, `packages/coding-agent/test/fixtures/**`, `packages/testing/test/fixtures/**`, `scripts/bench-agent-platform.ts`, `scripts/check-agent-platform-plan.ts`, `scripts/check-agent-platform-plan.test.ts`, `scripts/check-agent-platform-worktree.ts`, `scripts/check-agent-platform-worktree.test.ts`, `scripts/check-agent-boundary.ts`, `scripts/check-agent-isolation.ts`, `scripts/check-public-boundary-release.ts`

<read_first>

- `packages/agent-protocol/package.json`
- `packages/coding-agent/package.json`
- `packages/testing/package.json`
- `scripts/check-agent-boundary.ts`
- `scripts/check-agent-isolation.ts`

</read_first>

<action>

Implement QLT-01 and production reachability for the tracer. Freeze golden version 1 snapshot, event, fake, replay, RPC, and `FileSessionStore` fixtures before updating package exports. Export pure protocol values, the `coding-agent/orchestration` subpath, and agent eval APIs without adding external dependencies. Create `scripts/bench-agent-platform.ts` plus root `bench:agent-platform`; create `scripts/check-agent-platform-plan.ts` plus root `check:agent-platform-plan`; create `scripts/check-agent-platform-worktree.ts` plus root `check:agent-platform-worktree`; and create the fail-closed `scripts/check-public-boundary-release.ts` plus root `check:public-boundary:release`. The plan audit parses REQUIREMENTS.md and every task's `Requirement IDs` and `Write allowlist`, requires exactly 24 tasks and 88 unique IDs with one owner each, rejects unknown, missing, or duplicate IDs, checks phase unions, and rejects non-ASCII dash code points in all four agent-platform artifacts. The worktree guard records dirty paths and SHA-256 digests under the git directory, enforces active allowlists against changed and staged paths, detects overlap, and supports isolated generation or release worktrees. Make the boundary scripts recognize only the new allowed leaf edges while preserving protected framework isolation. Do not migrate or reinterpret existing session content in this task.

</action>

<acceptance_criteria>

- Frozen legacy fixtures decode identically before and after the additive exports.
- Consumers can import the documented tracer surfaces from package exports.
- Protected framework consumers build with all agent packages absent.
- Package manifests add no third-party dependency.
- The task audit reports 24 tasks, 88 unique requirement IDs, zero duplicates, zero missing IDs, and zero non-ASCII dash characters.
- Worktree guard fixtures block overlapping dirty targets and out-of-allowlist changed or staged paths while preserving unrelated baselines.

</acceptance_criteria>

<verify>

- `bun test packages/agent-protocol/test packages/coding-agent/test/native-replay.test.ts packages/coding-agent/test/sessions.test.ts`
- `bun test scripts/check-agent-platform-plan.test.ts scripts/check-agent-platform-worktree.test.ts`
- `bun run check:agent-platform-plan && bun run bench:agent-platform --check evidence memory && bun run check:agent-boundary && bun run check:agent-isolation && bun run check:consumers`

</verify>

### Phase 1 tasks: Local orchestration and eval feedback

**Requirement coverage:** ORC-04, ORC-05, ORC-06, ORC-07, ORC-08, ORC-09, ORC-10, EVL-03, EVL-04, EVL-05

#### Task P1-T1: Expand compiler and catalog across existing primitives

**Requirement IDs:** ORC-04, ORC-05, ORC-07, ORC-08
**Write allowlist:** `packages/coding-agent/src/orchestration/compiler.ts`, `packages/coding-agent/src/orchestration/catalog.ts`, `packages/coding-agent/src/orchestration/index.ts`, `packages/coding-agent/test/orchestration-compiler.test.ts`

<read_first>

- `packages/coding-agent/src/orchestration/index.ts`
- `packages/coding-agent/src/workflows.ts`
- `packages/coding-agent/src/subagents.ts`
- `packages/coding-agent/src/approvals.ts`
- `packages/coding-agent/src/verification.ts`

</read_first>

<action>

Implement ORC-04, ORC-05, ORC-07, and ORC-08 in `packages/coding-agent/src/orchestration/compiler.ts`, `catalog.ts`, and focused tests. Compile sequence, bounded parallel, verify, approve, retry, branch, checkpoint, handoff, and subagent nodes to existing owners. Register step keys with version, parsed inputs, declared capabilities, artifact-reference outputs, and deterministic lookup. Enforce 256 nodes and all declared ceilings before execution, then enforce runtime deadline, cancellation, retry, and authority ceilings during execution. The compiler must not contain a second scheduler or copy the current runner switch.

</action>

<acceptance_criteria>

- Every declarative node kind has parity with a direct `WorkflowStep` fixture.
- Duplicate, missing, drifted, expanded-authority, and one-over-limit cases fail with stable codes before work.
- Parallel execution respects the lower of plan, host, and parent limits.
- Existing workflow and subagent suites remain unchanged and green.

</acceptance_criteria>

<verify>

- `bun test packages/coding-agent/test/orchestration-compiler.test.ts packages/coding-agent/test/workflows.test.ts packages/coding-agent/test/approvals.test.ts`
- `bun run --filter '@nifrajs/coding-agent' build`

</verify>

#### Task P1-T2: Orchestration lifecycle and evidence-only local stores

**Requirement IDs:** ORC-06, ORC-09, ORC-10
**Write allowlist:** `packages/coding-agent/src/orchestration/host.ts`, `packages/coding-agent/src/orchestration/evidence-store.ts`, `packages/coding-agent/src/orchestration/index.ts`, `packages/coding-agent/src/host.ts`, `packages/coding-agent/src/rpc.ts`, `packages/coding-agent/test/orchestration-host.test.ts`, `packages/coding-agent/test/orchestration-store.test.ts`, `scripts/bench-agent-platform.ts`

<read_first>

- `packages/coding-agent/src/host.ts`
- `packages/coding-agent/src/rpc.ts`
- `packages/coding-agent/src/sessions.ts`
- `packages/coding-agent/src/orchestration/compiler.ts`
- `packages/coding-agent/src/orchestration/index.ts`

</read_first>

<action>

Implement ORC-06, ORC-09, and ORC-10 in `packages/coding-agent/src/orchestration/host.ts` and `evidence-store.ts`. Add submit, inspect, start, safe pause, resume, cancel, and terminal-result operations backed by an explicit state machine. Add bounded memory and evidence-only local file stores with atomic record append, deterministic sequence, parsed writes, and no dependency on `FileSessionStore`. Terminal results expose status, completed node IDs, evidence digest, artifact references, counters, and failure code only. Extend `scripts/bench-agent-platform.ts` with checked compile and local scheduling modes for 256-node and no-op fixtures.

</action>

<acceptance_criteria>

- Every legal lifecycle path works and every illegal transition returns a stable code without mutation.
- Cancellation reaches active workflow and subagent work and late completion cannot change a terminal run.
- 1k, 10k, and 100k evidence-event fixtures keep a bounded live window and deterministic persisted order.
- A forbidden content field cannot be written through either reference store.

</acceptance_criteria>

<verify>

- `bun test packages/coding-agent/test/orchestration-host.test.ts packages/coding-agent/test/orchestration-store.test.ts packages/coding-agent/test/agent-surfaces.test.ts`
- `bun run bench:agent-platform --check compile schedule memory`

</verify>

#### Task P1-T3: Eval suites, rubrics, and baselines

**Requirement IDs:** EVL-03, EVL-04, EVL-05
**Write allowlist:** `packages/testing/src/agent-eval.ts`, `packages/testing/src/index.ts`, `packages/testing/test/agent-eval.test.ts`

<read_first>

- `packages/testing/src/agent-eval.ts`
- `packages/testing/src/trajectory.ts`
- `packages/testing/src/failure-lab.ts`
- `packages/testing/src/idempotency.ts`
- `packages/testing/src/index.ts`

</read_first>

<action>

Implement EVL-03, EVL-04, and EVL-05 in `packages/testing/src/agent-eval.ts` and its tests. Add `defineAgentEvalSuite`, deterministic execution, bounded typed rubric ports, baseline comparison, explicit tolerances, and stable regression IDs. Reports may contain only the evidence contract. Free-form evaluator reasoning and an opaque aggregate agent score are not valid public outputs.

</action>

<acceptance_criteria>

- Duplicate case IDs fail; deterministic case order and digests survive declaration reordering.
- Rubrics reject unbounded text, invalid numeric ranges, and unknown outcome codes.
- Baseline tests cover equal, improved, tolerated, regressed, missing, and incomparable cases.
- A seeded orchestration regression fails the assertion API with a stable regression ID.

</acceptance_criteria>

<verify>

- `bun test packages/testing/test/agent-eval.test.ts packages/testing/test/trajectory.test.ts packages/testing/test/failure-lab.test.ts`
- `bun run --filter '@nifrajs/testing' build`

</verify>

### Phase 2 tasks: Agent App SDK and Workbench cutover

**Requirement coverage:** APS-02, APS-03, APS-04, APS-05, APS-06, APS-07, APS-08, APS-09, UX-01

#### Task P2-T1: Additive protocol lifecycle, features, and cursor resume

**Requirement IDs:** APS-02, APS-03
**Write allowlist:** `packages/agent-protocol/src/run-lifecycle.ts`, `packages/agent-protocol/src/index.ts`, `packages/agent-protocol/test/index.test.ts`, `packages/agent-protocol/test/run-lifecycle.test.ts`, `packages/coding-agent/src/rpc.ts`, `packages/coding-agent/test/rpc.test.ts`

<read_first>

- `packages/agent-protocol/src/index.ts`
- `packages/agent-protocol/src/evidence.ts`
- `packages/agent-protocol/src/run-plan.ts`
- `packages/agent-protocol/test/index.test.ts`
- `packages/coding-agent/src/rpc.ts`

</read_first>

<action>

Implement APS-02 and APS-03 in `packages/agent-protocol/src/run-lifecycle.ts` and protocol tests. Add optional version 1 `RunPlanRef`, `RunSnapshot`, `RunEvidenceEvent`, `HandoffSnapshot`, feature negotiation, cursor, stale-cursor, and resync values. Update local RPC to expose the bounded current snapshot and sequence window. Preserve all current required fields and meanings and keep unknown additive fields forward-compatible at transport decoders while evidence sinks remain strict.

</action>

<acceptance_criteria>

- Old/new host-client fixture combinations retain legacy behavior.
- A valid cursor resumes at the next sequence; duplicates are identifiable; a missing window returns `resync_required`.
- Unknown commands are reported as unsupported negotiated features.
- `AGENT_PROTOCOL_VERSION` remains `1`.

</acceptance_criteria>

<verify>

- `bun test packages/agent-protocol/test/index.test.ts packages/agent-protocol/test/run-lifecycle.test.ts packages/coding-agent/test/rpc.test.ts`
- `bun run --filter '@nifrajs/agent-protocol' --filter '@nifrajs/coding-agent' build`

</verify>

#### Task P2-T2: Create protocol-only Agent App SDK

**Requirement IDs:** APS-04, APS-05, APS-06, APS-07, APS-08, APS-09
**Write allowlist:** `packages/agent-app/**`, `package.json`, `scripts/check-consumer-matrix.ts`, `scripts/public-package-manifest.ts`, `scripts/check-agent-boundary.ts`

<read_first>

- `packages/agent-protocol/README.md`
- `packages/agent-protocol/package.json`
- `packages/coding-agent/src/rpc.ts`
- `packages/coding-agent/src/replay.ts`
- `package.json`

</read_first>

<action>

Implement APS-04 through APS-09 by creating `packages/agent-app/package.json`, `tsconfig.build.json`, `src/client.ts`, `src/transport.ts`, `src/view-models.ts`, `src/index.ts`, README, and focused tests. `AgentAppClient` owns negotiated commands, caller-auth hooks, Web fetch/SSE transport, ordered dedupe, reconnect, cancellation, approval and handoff resolution, replay selection, and presentation-safe view models. Add only `@nifrajs/agent-protocol` as a dependency and export the package root. Update the existing root `build` script so the new `@nifrajs/agent-app` filtered build runs after `@nifrajs/agent-protocol` and before `@nifrajs/workbench`; update public package and consumer matrices in the same task. Add no React, Pi, coding-agent, provider, storage, desktop, or secret behavior.

</action>

<acceptance_criteria>

- The SDK package builds and imports in an isolated consumer with only protocol installed.
- Fake, replay, and local RPC backends pass the same command and stream conformance suite.
- Caller credentials are never stored, logged, or copied into evidence and errors.
- Random duplicate, reorder, disconnect, and stale-cursor sequences either converge in order or require resync.

</acceptance_criteria>

<verify>

- `bun test packages/agent-app/test`
- `bun run --filter '@nifrajs/agent-app' build && bun run check:consumers && bun run check:agent-boundary`

</verify>

#### Task P2-T3: Cut Workbench production UI to the SDK

**Requirement IDs:** UX-01
**Write allowlist:** `apps/workbench/package.json`, `apps/workbench/src/server.ts`, `apps/workbench/src/browser.ts`, `apps/workbench/scripts/build-assets.ts`, `apps/workbench/public/app.js`, `apps/workbench/public/index.html`, `apps/workbench/dist/**`, `apps/workbench/README.md`, `apps/workbench/test/agent-app-smoke.test.ts`, `apps/workbench/test/built-browser-smoke.test.ts`

<read_first>

- `apps/workbench/src/server.ts`
- `apps/workbench/public/app.js`
- `apps/workbench/public/index.html`
- `apps/workbench/package.json`
- `apps/workbench/README.md`

</read_first>

<action>

Implement UX-01 with a typed `apps/workbench/src/browser.ts` entrypoint that imports `AgentAppClient` and safe view models from `@nifrajs/agent-app`. Add `@nifrajs/agent-app: workspace:*` to `apps/workbench/package.json`; keep the existing `@nifrajs/coding-agent` dependency for `src/server.ts` only. Add `apps/workbench/scripts/build-assets.ts` to copy `public/index.html` to `dist/public/index.html`, and set concrete package scripts: `build:browser` is `bun build src/browser.ts --target browser --format esm --outfile dist/public/app.js && bun run scripts/build-assets.ts`; `build:server` is `bun build src/server.ts --target bun --outfile dist/server.js`; `build` runs browser then server; `dev` builds browser assets before starting `src/server.ts`. Change `src/server.ts` to serve `dist/public/index.html` and `dist/public/app.js` from an asset root that resolves identically when the server runs from `src` or `dist`. Move the legacy browser implementation out of `public/app.js` into the typed entrypoint and delete the obsolete source asset so no unbundled alternate client remains. Replace browser-local RPC and event interpretation with SDK commands and view models, and add selectable fake or replay launcher modes for tests. Production browser code must not import Pi, `NifraBackend`, `FileSessionStore`, coding-agent host internals, or private APIs; it receives only the SDK transport URL, caller-provided token, negotiated features, and safe view models. Add `built-browser-smoke.test.ts` that builds first, starts the replay launcher, fetches the emitted index and JavaScript from the actual server, verifies JavaScript MIME and module load path, and asserts the bundle contains no unresolved bare `@nifrajs/agent-app` import.

</action>

<acceptance_criteria>

- Existing Workbench session, approval, diff, verification, and workflow smoke behavior remains available.
- Fake and replay backends render and execute without Pi or model access.
- Browser dependency scan has no backend-internal or session-file dependency.
- Unsupported features show bounded UI states and do not issue invalid commands.
- `dist/server.js` and `dist/public/app.js` are emitted, the server returns the emitted asset, and the browser bundle has no unresolved workspace-package specifier.
- The obsolete `public/app.js` source is absent and no server path can fall back to serving it verbatim.

</acceptance_criteria>

<verify>

- `bun run --filter '@nifrajs/workbench' build`
- `bun test apps/workbench/test/built-browser-smoke.test.ts apps/workbench/test/agent-app-smoke.test.ts packages/agent-app/test`
- `bun run check:agent-isolation && bun run check:agent-boundary`

</verify>

### Phase 3 tasks: Registry, policy, approval, and handoff

**Requirement coverage:** REG-01, REG-02, REG-03, REG-04, REG-05, REG-06, REG-07, REG-08, UX-02, UX-03, UX-04, UX-05

#### Task P3-T1: Unified descriptor registry and adapters

**Requirement IDs:** REG-01, REG-02, REG-03, REG-04, REG-05, REG-08
**Write allowlist:** `package.json`, `packages/agent/src/registry.ts`, `packages/agent/src/index.ts`, `packages/agent/package.json`, `packages/agent/test/registry.test.ts`, `packages/mcp/src/agent-descriptor.ts`, `packages/mcp/package.json`, `packages/mcp/test/agent-descriptor.test.ts`, `packages/mcp/test/dependency-direction.test.ts`, `packages/coding-agent/src/registry.ts`, `packages/coding-agent/src/index.ts`, `packages/coding-agent/package.json`, `packages/coding-agent/test/registry.test.ts`, `packages/coding-agent/test/dependency-direction.test.ts`, `packages/testing/src/agent-certification.ts`, `packages/testing/src/index.ts`, `packages/testing/test/agent-certification.test.ts`, `scripts/check-agent-boundary.ts`

<read_first>

- `packages/agent/src/index.ts`
- `packages/core/src/tool-contract.ts`
- `packages/mcp/src/tool-contract.ts`
- `packages/coding-agent/src/extensions.ts`
- `packages/coding-agent/src/capabilities.ts`

</read_first>

<action>

Implement REG-01 through REG-05 and REG-08. Add `packages/agent/src/registry.ts` with strict `CapabilityDescriptor`, canonical snapshot composition, schema digest, collision and drift codes, and the core tool adapter; export it from the root and an explicit `./registry` subpath in `packages/agent/package.json`. Add `packages/mcp/src/agent-descriptor.ts` as an optional descriptor projection and export `./agent-descriptor` from `packages/mcp/package.json`. Because that opt-in subpath consumes registry runtime contracts, add `@nifrajs/agent: workspace:^` as an optional peer and `@nifrajs/agent: workspace:*` as a development dependency to MCP; do not add it to MCP's base root import path or move invocation and transport. Add the extension projection in `packages/coding-agent/src/registry.ts`, export `./registry`, and add `@nifrajs/agent: workspace:*` to coding-agent dependencies. Update the existing root `build` script in the same task so `@nifrajs/core` builds before `@nifrajs/agent`, and `@nifrajs/agent` builds before both `@nifrajs/mcp` and `@nifrajs/coding-agent`; this replaces the current coding-agent-before-agent order before the new edge is exercised. Add `registryCertificationProfile` to `packages/testing/src/agent-certification.ts`. Add isolated dependency-direction tests asserting the only new edges are `mcp -> agent` and `coding-agent -> agent`, and that neither agent nor protocol imports MCP or coding-agent. Reports remain evidence-only.

</action>

<acceptance_criteria>

- Core, MCP, and extension fixtures produce equivalent names, schema digests, and capability declarations.
- Registry input order does not change snapshot digest.
- Collision, missing version, schema drift, content field, and unsupported kind fail with stable codes.
- MCP transport and tool invocation tests remain owned by and green in `@nifrajs/mcp`.
- Packed or isolated consumers resolve `@nifrajs/agent/registry`, `@nifrajs/mcp/agent-descriptor`, and `@nifrajs/coding-agent/registry` through declared manifests; base MCP remains importable without activating the optional descriptor peer.
- The root build order is topological for `core -> agent -> mcp or coding-agent` before the new imports are built.

</acceptance_criteria>

<verify>

- `bun test packages/agent/test/registry.test.ts packages/mcp/test/agent-descriptor.test.ts packages/coding-agent/test/registry.test.ts packages/testing/test/agent-certification.test.ts`
- `bun test packages/mcp/test/dependency-direction.test.ts packages/coding-agent/test/dependency-direction.test.ts`
- `bun run --filter '@nifrajs/agent' --filter '@nifrajs/mcp' --filter '@nifrajs/coding-agent' --filter '@nifrajs/testing' build && bun run check:consumers && bun run check:agent-boundary`

</verify>

#### Task P3-T2: Host policy and approval or handoff lifecycle

**Requirement IDs:** REG-06, REG-07, UX-02, UX-03, UX-04
**Write allowlist:** `packages/coding-agent/src/handoffs.ts`, `packages/coding-agent/src/approvals.ts`, `packages/coding-agent/src/orchestration/host.ts`, `packages/coding-agent/src/orchestration/policy.ts`, `packages/coding-agent/src/index.ts`, `packages/coding-agent/test/approvals.test.ts`, `packages/coding-agent/test/handoffs.test.ts`, `packages/coding-agent/test/orchestration-policy.test.ts`, `packages/agent-protocol/src/run-lifecycle.ts`, `packages/agent-protocol/src/index.ts`, `packages/agent-app/src/client.ts`, `packages/agent-app/test/hit-lifecycle.test.ts`

<read_first>

- `packages/coding-agent/src/approvals.ts`
- `packages/coding-agent/src/orchestration/host.ts`
- `packages/agent/src/registry.ts`
- `packages/agent-protocol/src/run-lifecycle.ts`
- `packages/agent-app/src/client.ts`

</read_first>

<action>

Implement REG-06, REG-07, UX-02, UX-03, and UX-04. Add host policy admission before invocation, monotonic child-vector validation, and typed approval or handoff state machines. Extend `ApprovalManager` through a separate `packages/coding-agent/src/handoffs.ts` coordinator rather than weakening existing approval semantics. Expose list, inspect, approve, deny, assign, resolve, expire, and cancel commands through negotiated protocol and SDK features. Match every decision to run, node, capability, request ID, and expiry; stale or mismatched decisions fail closed.

</action>

<acceptance_criteria>

- Descriptors, plans, models, extensions, and clients cannot override host policy.
- Approval and handoff state machines reject duplicate, late, mismatched, unknown, and authority-expanding transitions.
- Expiry denies or expires closed and resumes no work.
- A successful resolution resumes exactly one matching paused boundary.

</acceptance_criteria>

<verify>

- `bun test packages/coding-agent/test/approvals.test.ts packages/coding-agent/test/handoffs.test.ts packages/coding-agent/test/orchestration-policy.test.ts packages/agent-app/test/hit-lifecycle.test.ts`
- `bun run check:agent-isolation`

</verify>

#### Task P3-T3: Workbench registry and HITL inbox

**Requirement IDs:** UX-05
**Write allowlist:** `apps/workbench/src/browser.ts`, `apps/workbench/public/index.html`, `apps/workbench/README.md`, `apps/workbench/test/hit-inbox.test.ts`, `apps/workbench/test/registry-view.test.ts`, `packages/agent-app/src/view-models.ts`, `packages/agent-app/test/view-models.test.ts`

<read_first>

- `apps/workbench/src/browser.ts`
- `apps/workbench/public/index.html`
- `apps/workbench/test/built-browser-smoke.test.ts`
- `packages/agent-app/src/view-models.ts`
- `apps/workbench/README.md`
- `packages/coding-agent/test/rpc.test.ts`

</read_first>

<action>

Implement UX-05 and complete the Phase 3 vertical slice. Add Workbench registry inspection and a pending approval or handoff inbox driven only by SDK view models. Show run ID, node ID, capability, bounded ownership reference, expiry, state, and evidence links. Support approve, deny, assign, resolve, and cancel only when negotiated and current. Do not render prompts, reasons containing arbitrary text, tool data, model data, diagnostics, or artifacts. Modify the typed `apps/workbench/src/browser.ts` source and `apps/workbench/public/index.html` template for UI behavior; do not edit `dist/public/app.js`, which remains generated by the P2 `build:browser` pipeline and is checked through `built-browser-smoke.test.ts` after rebuilding.

</action>

<acceptance_criteria>

- Replay fixtures cover pending, approved, denied, assigned, resolved, expired, cancelled, stale, and unsupported states.
- UI commands include the matching request identity and cannot resolve a different item.
- Registry and inbox remain usable with Pi unavailable.
- Visual fixtures contain no content-bearing field.

</acceptance_criteria>

<verify>

- `bun run --filter '@nifrajs/workbench' build && bun test apps/workbench/test/built-browser-smoke.test.ts apps/workbench/test/hit-inbox.test.ts apps/workbench/test/registry-view.test.ts packages/coding-agent/test/rpc.test.ts`

</verify>

### Phase 4 tasks: Provider gateway and deployment contracts

**Requirement coverage:** GTW-01, GTW-02, GTW-03, GTW-04, GTW-05, GTW-06, GTW-07, DEP-01, DEP-02, DEP-03, DEP-04, DEP-05, DEP-06, DEP-07

#### Task P4-T1: Provider-neutral model gateway

**Requirement IDs:** GTW-01, GTW-02, GTW-03, GTW-04, GTW-05, GTW-06
**Write allowlist:** `packages/agent/src/gateway.ts`, `packages/agent/src/index.ts`, `packages/agent/test/gateway.test.ts`, `packages/coding-agent/src/native.ts`, `packages/coding-agent/src/replay.ts`, `packages/coding-agent/test/native-replay.test.ts`, `scripts/bench-agent-platform.ts`

<read_first>

- `packages/agent/src/index.ts`
- `packages/coding-agent/src/native.ts`
- `packages/coding-agent/src/replay.ts`
- `packages/agent/src/execution-policy.ts`
- `packages/agent/test/agent.test.ts`

</read_first>

<action>

Implement GTW-01 through GTW-06 in `packages/agent/src/gateway.ts` and `packages/agent/test/gateway.test.ts`. Add validated request and result contracts, `StructuredOutputParser`, stable error taxonomy, explicit `ModelRoutePolicy`, monotonic budget and deadline envelope, and evidence-only attempt or fallback records. Add deterministic fake and replay adapters. Retry or fallback only on caller-declared codes and never silently alter route. Adapt `NifraBackend` through the gateway port without making Pi or native the default. Extend `scripts/bench-agent-platform.ts` with a checked fake-direct versus gateway-overhead mode.

</action>

<acceptance_criteria>

- Every success, malformed output, refusal, timeout, rate limit, unavailable, policy, cancelled, and internal branch is parsed and tested.
- Retries and route changes stop at the first non-retryable code or exhausted vector.
- Fake and replay adapters make no network or real tool call.
- Gateway evidence contains no prompts, messages, response body, raw diagnostic, credential, price, or spend value.

</acceptance_criteria>

<verify>

- `bun test packages/agent/test/gateway.test.ts packages/agent/test/agent.test.ts packages/coding-agent/test/native-replay.test.ts`
- `bun run --filter '@nifrajs/agent' --filter '@nifrajs/coding-agent' build && bun run bench:agent-platform --check gateway`

</verify>

#### Task P4-T2: Deployment lifecycle and reference profiles

**Requirement IDs:** DEP-01, DEP-02, DEP-03, DEP-05, DEP-07
**Write allowlist:** `packages/agent/src/deployment.ts`, `packages/agent/src/index.ts`, `packages/agent/test/deployment.test.ts`, `packages/coding-agent/src/deployment-adapters.ts`, `packages/coding-agent/src/index.ts`, `packages/coding-agent/test/deployment-adapters.test.ts`

<read_first>

- `packages/agent/src/execution-policy.ts`
- `packages/runner/src/index.ts`
- `packages/coding-agent/src/process.ts`
- `packages/coding-agent/src/isolated-worker.ts`
- `packages/testing/src/certification.ts`

</read_first>

<action>

Implement DEP-01, DEP-02, DEP-03, DEP-05, and DEP-07. Add `packages/agent/src/deployment.ts` for prepare, start, inspect, cancel, dispose, and capability report contracts. Add truthful local process, CI, and replay profiles in `packages/coding-agent/src/deployment-adapters.ts`. Require explicit runtime, network, filesystem, process, secret, workspace, cancellation, and hostile-code-isolation declarations. Reject hostile-code plans for local reference profiles. Adapter activation and child deployment vectors remain host-owned and monotonic.

</action>

<acceptance_criteria>

- Every lifecycle transition and cleanup path is deterministic under an injected clock and abort signal.
- Missing, contradictory, or overstated capabilities fail before prepare or start.
- Local process, runner, replay, and extension worker report no hostile-code isolation.
- Cancellation and workspace limits cannot widen during child deployment.

</acceptance_criteria>

<verify>

- `bun test packages/agent/test/deployment.test.ts packages/coding-agent/test/deployment-adapters.test.ts packages/agent/test/execution-policy.test.ts packages/runner/test`
- `bun run check:agent-isolation`

</verify>

#### Task P4-T3: Gateway and deployment certification boundary

**Requirement IDs:** GTW-07, DEP-04, DEP-06
**Write allowlist:** `packages/testing/src/agent-certification.ts`, `packages/testing/src/index.ts`, `packages/testing/test/agent-certification.test.ts`, `packages/agent/test/gateway.test.ts`, `packages/coding-agent/test/deployment-adapters.test.ts`, `scripts/public-agent-reference-allowlist.json`, `scripts/check-agent-boundary.ts`, `scripts/check-public-boundary.test.ts`

<read_first>

- `packages/testing/src/certification.ts`
- `packages/testing/src/agent-certification.ts`
- `packages/agent/package.json`
- `packages/coding-agent/package.json`
- `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`

</read_first>

<action>

Implement GTW-07, DEP-04, and DEP-06. Add gateway and deployment certification profiles to `@nifrajs/testing` covering parse boundaries, lifecycle, fallback, cancellation, cleanup, capability truthfulness, evidence firewall, and isolation claims. Add deliberately leaking and lying fixtures that must fail named checks. Confirm provider SDKs remain optional leaf concerns and no public package gains credential, pricing, tenant, fleet, managed deployment, or private topology implementation.

</action>

<acceptance_criteria>

- Fake, replay, local, and CI references pass their applicable certification profiles.
- A leaking adapter and false isolation claim fail stable named checks.
- Public dependency graph contains no provider SDK or operated-depth dependency.
- Certification reports remain within evidence schema and record cap.

</acceptance_criteria>

<verify>

- `bun test packages/testing/test/agent-certification.test.ts packages/agent/test/gateway.test.ts packages/coding-agent/test/deployment-adapters.test.ts`
- `bun run check:public-boundary && bun run check:agent-boundary`

</verify>

### Phase 5 tasks: At-least-once jobs and recovery

**Requirement coverage:** JOB-01, JOB-02, JOB-03, JOB-04, JOB-05, JOB-06, JOB-07, JOB-08

#### Task P5-T1: Dispatch contracts and jobs adapter tracer

**Requirement IDs:** JOB-01, JOB-02, JOB-03
**Write allowlist:** `package.json`, `packages/coding-agent/src/orchestration/dispatch.ts`, `packages/coding-agent/src/orchestration/durable-jobs.ts`, `packages/coding-agent/src/orchestration/index.ts`, `packages/coding-agent/package.json`, `packages/coding-agent/test/durable-jobs.test.ts`, `packages/coding-agent/test/dependency-direction.test.ts`, `scripts/check-agent-boundary.ts`

<read_first>

- `packages/jobs/src/types.ts`
- `packages/jobs/src/queue.ts`
- `packages/jobs/test/certification.test.ts`
- `packages/coding-agent/src/orchestration/host.ts`
- `packages/testing/src/idempotency.ts`

</read_first>

<action>

Implement JOB-01, JOB-02, and JOB-03 in `packages/coding-agent/src/orchestration/dispatch.ts` and `durable-jobs.ts`. Define evidence-only run dispatch, lease, checkpoint, and injected-clock contracts. Adapt them to existing `JobStore` at-least-once lease semantics. Add `@nifrajs/jobs: workspace:*` to `packages/coding-agent/package.json` and re-export the dispatch and durable-jobs APIs through the already-published `@nifrajs/coding-agent/orchestration` subpath; do not create a jobs-to-agent edge or an undeclared deep import. Update the existing root `build` script in this task so `@nifrajs/jobs` builds before `@nifrajs/coding-agent`, preserving the earlier `core -> agent -> coding-agent` order. Derive stable idempotency keys from plan digest, run ID, node ID, and logical attempt boundary and pass them to effect execution. Extend the isolated dependency-direction fixture to assert `coding-agent -> jobs`, reject `jobs -> agent` or `jobs -> coding-agent`, and prove a packed coding-agent consumer imports the durable adapter with declared dependencies installed. Do not add agent types or dependencies to `@nifrajs/jobs`.

</action>

<acceptance_criteria>

- One run node dispatches through the real memory `JobStore` adapter and completes the existing orchestration node.
- Duplicate delivery uses the same logical idempotency key; a divergent effect is rejected.
- The jobs package source and manifest remain agent-free and dependency-free.
- Dispatch, lease, and checkpoint values reject content fields.
- The durable adapter resolves from the documented orchestration export with no undeclared deep import, and manifest tests prove the one-way `coding-agent -> jobs` edge.
- The root build order places jobs before coding-agent before exercising the new runtime import.

</acceptance_criteria>

<verify>

- `bun test packages/coding-agent/test/durable-jobs.test.ts packages/jobs/test/certification.test.ts packages/testing/test/idempotency.test.ts`
- `bun test packages/coding-agent/test/dependency-direction.test.ts`
- `bun run --filter '@nifrajs/jobs' --filter '@nifrajs/coding-agent' build && bun run check:consumers && bun run check:agent-boundary`

</verify>

#### Task P5-T2: Recovery state machine and failure convergence

**Requirement IDs:** JOB-04, JOB-05, JOB-06, JOB-07
**Write allowlist:** `packages/coding-agent/src/orchestration/dispatch.ts`, `packages/coding-agent/src/orchestration/durable-jobs.ts`, `packages/coding-agent/src/orchestration/recovery.ts`, `packages/coding-agent/test/recovery.test.ts`, `packages/coding-agent/README.md`, `packages/jobs/README.md`, `packages/testing/test/agent-failure-matrix.test.ts`

<read_first>

- `packages/coding-agent/src/orchestration/dispatch.ts`
- `packages/coding-agent/src/orchestration/durable-jobs.ts`
- `packages/testing/src/failure-lab.ts`
- `packages/testing/src/fault-profile.ts`
- `packages/jobs/src/memory-store.ts`

</read_first>

<action>

Implement JOB-04 through JOB-07. Add safe-boundary checkpoint rules, lease generation checks, retry backoff, cancellation, late-completion rejection, dead-letter evidence, disposable memory adapter behavior, and deterministic recovery schedule tokens. Use injected clocks and the existing failure lab. Claim at-least-once delivery only. A completed side effect may resume past its boundary only with matching idempotency proof.

</action>

<acceptance_criteria>

- Crash-before-effect, crash-after-effect, crash-after-checkpoint, duplicate delivery, lease expiry, worker loss, cancellation race, and late completion converge to one legal terminal state.
- Older lease generations cannot commit after a newer lease or terminal transition.
- Dead-letter evidence contains only IDs, attempts, status code, schedule token, timestamps, and digests.
- Documentation and error strings contain no exactly-once or hostile durability promise.

</acceptance_criteria>

<verify>

- `bun test packages/coding-agent/test/recovery.test.ts packages/testing/test/failure-lab.test.ts packages/jobs/test/memory-store.test.ts packages/jobs/test/queue.test.ts`
- `bun run bench:agent`

</verify>

#### Task P5-T3: Private durable adapter handoff

**Requirement IDs:** JOB-08
**Write allowlist:** `packages/coding-agent/README.md`, `packages/jobs/README.md`, `packages/coding-agent/test/private-dispatch-conformance.test.ts`, `docs/agent-platform/private-dispatch-adapters.md`

<read_first>

- `packages/coding-agent/src/orchestration/dispatch.ts`
- `packages/coding-agent/README.md`
- `packages/jobs/README.md`
- `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`
- `.planning/agent-platform/REQUIREMENTS.md`

</read_first>

<action>

Implement JOB-08 and document the public/private dispatch seam. Add a conformance-only fake private adapter fixture that demonstrates durable queue, worker, data-layer authorization, RLS, retention, reconciliation, and fleet hooks through public ports without encoding a vendor, schema, topology, or implementation in public packages. Document stable idempotency, lease, cancellation, checkpoint, and evidence obligations.

</action>

<acceptance_criteria>

- The fake adapter compiles and passes dispatch certification using opaque caller context.
- Public types contain no tenant row, RLS policy, retention period, credential, provider, or fleet implementation.
- Public docs distinguish disposable local references from durable operated adapters.
- No private product or workspace topology appears in public tests or docs.

</acceptance_criteria>

<verify>

- `bun test packages/coding-agent/test/private-dispatch-conformance.test.ts`
- `bun run check:public-boundary && bun run check:docs`

</verify>

### Phase 6 tasks: Evaluation and observability studio

**Requirement coverage:** EVL-06, EVL-07, EVL-08, EVL-09, UX-06, UX-07, UX-08, UX-09, UX-10

#### Task P6-T1: Agent eval composition and failure matrix

**Requirement IDs:** EVL-06, EVL-07, EVL-08, EVL-09
**Write allowlist:** `packages/testing/src/agent-eval.ts`, `packages/testing/src/index.ts`, `packages/testing/test/agent-eval.test.ts`, `packages/testing/test/agent-failure-matrix.test.ts`, `scripts/bench-agent-platform.ts`

<read_first>

- `packages/testing/src/agent-eval.ts`
- `packages/testing/src/trajectory.ts`
- `packages/testing/src/fault-profile.ts`
- `packages/testing/src/contract-lab.ts`
- `packages/testing/src/agent-certification.ts`

</read_first>

<action>

Implement EVL-06 through EVL-09. Compose eval suites with existing trajectory replay, failure schedules, contract lab, idempotency proofs, and adapter certification. Add model, tool, approval, cancellation, lease, cursor, registry, and deployment fault matrix fixtures. Emit machine-readable evidence-only CI reports and `assertAgentEval` failures for explicit invariants, rubric outcomes, tolerances, and stable codes. Store no prompts, labels, examples, trajectories, corpora, or accumulated fault intelligence. Extend `scripts/bench-agent-platform.ts` with the checked 1,000-step deterministic replay mode.

</action>

<acceptance_criteria>

- Fixed seeds and schedule tokens reproduce identical failure and regression IDs.
- The CI fixture exits nonzero for each seeded regression and passes for declared tolerance.
- Reports contain no opaque aggregate score and pass the shared evidence parser.
- Source analysis shows the composition calls existing replay, failure, idempotency, contract, and certification owners.

</acceptance_criteria>

<verify>

- `bun test packages/testing/test/agent-eval.test.ts packages/testing/test/agent-failure-matrix.test.ts packages/testing/test/trajectory.test.ts packages/testing/test/certification.test.ts`
- `bun run --filter '@nifrajs/testing' build && bun run bench:agent-platform --check replay`

</verify>

#### Task P6-T2: Cardinality-safe correlated telemetry

**Requirement IDs:** UX-06
**Write allowlist:** `packages/agent-telemetry/src/index.ts`, `packages/agent-telemetry/test/telemetry.test.ts`, `packages/agent-telemetry/test/orchestration.test.ts`, `packages/agent-telemetry/README.md`

<read_first>

- `packages/agent-telemetry/src/index.ts`
- `packages/agent-telemetry/test/telemetry.test.ts`
- `packages/otel/src/index.ts`
- `packages/agent-protocol/src/evidence.ts`
- `packages/coding-agent/src/orchestration/dispatch.ts`

</read_first>

<action>

Implement UX-06. Extend `@nifrajs/agent-telemetry` with run, plan, node, attempt, evidence, replay, and trace correlation. Define an explicit attribute allowlist, maximum string length, counter bounds, and cardinality rules. Export no prompt, message, tool data, provider response, artifact, diagnostic, secret, workspace path, or arbitrary error text. Preserve telemetry-off-by-default behavior and map retries or recovery to linked spans without losing the stable logical node identity.

</action>

<acceptance_criteria>

- Correlation remains stable across retry, lease recovery, replay, and cancellation.
- Unknown, content-bearing, oversized, or unbounded attributes are rejected or dropped with a bounded counter.
- No telemetry exporter is enabled by default.
- Existing tool and MCP telemetry behavior remains compatible.

</acceptance_criteria>

<verify>

- `bun test packages/agent-telemetry/test/telemetry.test.ts packages/agent-telemetry/test/orchestration.test.ts`
- `bun run --filter '@nifrajs/agent-telemetry' build`

</verify>

#### Task P6-T3: Workbench run graph, timeline, and eval views

**Requirement IDs:** UX-07, UX-08, UX-09, UX-10
**Write allowlist:** `package.json`, `apps/workbench/src/browser.ts`, `apps/workbench/public/index.html`, `apps/workbench/test/run-studio.test.ts`, `apps/workbench/test/eval-view.test.ts`, `apps/workbench/test/privacy-view.test.ts`, `packages/agent-app/src/view-models.ts`, `packages/agent-app/test/view-models.test.ts`, `scripts/bench-workbench-agent.ts`

<read_first>

- `package.json`
- `apps/workbench/src/browser.ts`
- `apps/workbench/public/index.html`
- `apps/workbench/test/built-browser-smoke.test.ts`
- `packages/agent-app/src/view-models.ts`
- `packages/testing/src/agent-eval.ts`
- `packages/agent-telemetry/src/index.ts`

</read_first>

<action>

Implement UX-07 through UX-10. Add SDK view models and Workbench surfaces for run dependency graph, active state, checkpoints, retries, cancellations, recovery, evidence timeline, trace-to-replay links, eval comparison, and deterministic fault injection. Create `scripts/bench-workbench-agent.ts` as a replay-driven checked benchmark and add the exact root `package.json` script `"check:workbench-agent": "bun run scripts/bench-workbench-agent.ts --check"`. Virtualize beyond 1,000 rows and keep bounded DOM and memory. Links reference evidence, trace, replay, schedule, or caller-owned artifact IDs only; the UI does not read `FileSessionStore` or backend internals. Modify the typed `apps/workbench/src/browser.ts` source and `apps/workbench/public/index.html` template for UI behavior; do not edit `dist/public/app.js`, which remains generated by the P2 `build:browser` pipeline and is checked through `built-browser-smoke.test.ts` after rebuilding.

</action>

<acceptance_criteria>

- Replay browser fixtures reconstruct sequential, parallel, branched, approved, handed-off, retried, cancelled, dead-lettered, and recovered runs at each cursor.
- Eval views distinguish pass, tolerance, regression, missing baseline, and incomparable schema without an opaque score.
- p95 evidence-event-to-render is at most 16 ms and orchestration view is usable within 1 second after RPC readiness.
- Histories above 1,000 rows are virtualized and content fields are absent from DOM snapshots.
- The root `package.json` contains `"check:workbench-agent": "bun run scripts/bench-workbench-agent.ts --check"`, and `bun run check:workbench-agent` exits zero.

</acceptance_criteria>

<verify>

- `bun run --filter '@nifrajs/workbench' build && bun test apps/workbench/test/built-browser-smoke.test.ts apps/workbench/test/run-studio.test.ts apps/workbench/test/eval-view.test.ts apps/workbench/test/privacy-view.test.ts`
- `bun run check:workbench-agent`

</verify>

### Phase 7 tasks: Compatibility and release hardening

**Requirement coverage:** QLT-02, QLT-03, QLT-04, QLT-05, QLT-06, QLT-07, QLT-08, QLT-09, QLT-10, QLT-11, QLT-12

#### Task P7-T1: Protocol matrix and legacy session evidence migration

**Requirement IDs:** QLT-02, QLT-03
**Write allowlist:** `packages/agent-protocol/test/compatibility.test.ts`, `packages/agent-app/test/compatibility.test.ts`, `packages/coding-agent/src/session-migration.ts`, `packages/coding-agent/src/cli.ts`, `packages/coding-agent/src/index.ts`, `packages/coding-agent/test/session-migration.test.ts`, `packages/coding-agent/README.md`, `docs/agent-platform/protocol-and-session-migration.md`

<read_first>

- `packages/agent-protocol/test/index.test.ts`
- `packages/coding-agent/src/sessions.ts`
- `packages/coding-agent/src/cli.ts`
- `packages/coding-agent/test/sessions.test.ts`
- `packages/agent-app/src/client.ts`

</read_first>

<action>

Implement QLT-02 and QLT-03. Build the old-client/new-host, new-client/old-host, new/new, and unsupported-feature compatibility matrix from frozen version 1 fixtures. Add a separate local migration command or library operation that reads legacy `FileSessionStore` records transiently and writes evidence-only records to a new directory, preserving session ID, sequence, timestamp, safe event code, counts, and digest while dropping content. Validate the target before any configuration switch and keep the source untouched for rollback. Record the semantic-incompatibility and dual-decoder prerequisites for any future protocol major.

</action>

<acceptance_criteria>

- All compatible matrix cells pass; unsupported features return the negotiated stable code.
- Migration output passes the evidence parser, preserves identity and ordering, and contains no legacy payload content.
- Interrupted or invalid migration leaves source and active configuration unchanged.
- Rollback to legacy local compatibility mode is documented and tested.

</acceptance_criteria>

<verify>

- `bun test packages/agent-protocol/test/compatibility.test.ts packages/agent-app/test/compatibility.test.ts packages/coding-agent/test/session-migration.test.ts`
- `bun run --filter '@nifrajs/agent-protocol' --filter '@nifrajs/agent-app' --filter '@nifrajs/coding-agent' build`

</verify>

#### Task P7-T2: Security, consumer, performance, and documentation closure

**Requirement IDs:** QLT-04, QLT-05, QLT-06, QLT-07, QLT-08, QLT-09, QLT-10
**Write allowlist:** `package.json`, `README.md`, `api-reference.md`, `llms.txt`, `llms-full.txt`, `packages/cli/docs/llms-full.txt`, `packages/cli/docs/examples.json`, `packages/cli/docs/types.json`, `packages/*/LLM.md`, `packages/node/src/generated/node-outcome.ts`, `packages/node/src/generated/bridge-markers.ts`, `scripts/check-agent-platform-plan.ts`, `scripts/check-agent-platform-worktree.ts`, `scripts/check-agent-boundary.ts`, `scripts/check-agent-isolation.ts`, `scripts/check-public-boundary.ts`, `scripts/check-public-boundary.test.ts`, `scripts/check-consumer-matrix.ts`, `scripts/bench-agent-platform.ts`, `scripts/bench-workbench-agent.ts`, `scripts/gen-llms.ts`, `scripts/gen-api-reference.ts`, `scripts/gen-llm-cards.ts`, `scripts/gen-node-outcome.ts`, `scripts/gen-public-product-manifest.ts`, `scripts/node-outcome-conformance.ts`, `packages/agent-protocol/README.md`, `packages/agent-app/README.md`, `packages/agent/README.md`, `packages/coding-agent/README.md`, `packages/coding-agent/SECURITY.md`, `packages/coding-agent/PERFORMANCE.md`, `packages/coding-agent/REGISTRY.md`, `packages/testing/README.md`, `packages/jobs/README.md`, `packages/agent-telemetry/README.md`, `apps/workbench/README.md`, `site/routes/docs/agents.tsx`, `site/routes/docs/backends.tsx`, `site/routes/docs/budgets.tsx`, `site/routes/docs/capabilities.tsx`, `site/routes/docs/certification.tsx`, `site/routes/docs/deployment.tsx`, `site/routes/docs/failure-lab.tsx`, `site/routes/docs/security.tsx`, `site/routes/docs/testing.tsx`, `site/routes/docs/troubleshooting.tsx`, `site/data/docs-nav.ts`, `docs/agent-platform/**`, `.changeset/*.md`

<read_first>

- `package.json`
- `scripts/check-agent-boundary.ts`
- `scripts/check-agent-isolation.ts`
- `scripts/check-consumer-matrix.ts`
- `packages/coding-agent/SECURITY.md`

</read_first>

<action>

Implement QLT-04 through QLT-10. Run `check:agent-platform-worktree baseline --task P7-T2` before any mutation and refuse an allowlisted generated or documentation target whose current digest overlaps unrelated baseline work. Add named security regressions for parsing, escalation, expiry, workspace and symlink escape, evidence leakage, remote binding, false adapter claims, and credential redaction. Extend existing build, publish, API generation, consumer, boundary, isolation, size, cold-start, corpus, coverage, and benchmark plumbing for changed packages and `@nifrajs/agent-app`. Update READMEs, LLM cards, API reference, security, troubleshooting, Workbench, migration, and changesets. Run all generators inside the isolated clean linked-worktree mode of `check:agent-platform-worktree`; capture a patch restricted to the P7-T2 allowlist, re-check every target digest in the shared worktree, and apply only when there is no overlap. Stage only the exact allowlisted generated and authored paths, verify the staged path set, and leave unrelated dirty files byte-identical and unstaged. Add the recorded orchestrator extraction gate: no package creation until a second production non-coding-agent consumer and coupling-reduction analysis are both present. Extend `check:agent-platform-plan` so its artifact-local ASCII dash scan and task ownership audit are release blocking; the existing Workbench plan remains outside its scan and is not modified.

</action>

<acceptance_criteria>

- Every named threat has a stable failing regression fixture and passing mitigation.
- Isolated consumers import every documented public subpath with workspace packages absent.
- Checked benchmarks enforce all PROGRAM-PLAN budgets without serializing payloads.
- Generated docs and corpora match source exports and state the same privacy, delivery, and isolation limitations.
- No orchestrator package exists without both recorded extraction proofs.
- The plan audit reports 24 task records owning all 88 IDs exactly once, complete task or phase allowlists, and no non-ASCII dash code point in the four agent-platform artifacts.
- Generation occurs in a clean linked worktree, refuses overlapping dirty targets, applies only an allowlisted patch, and leaves every unrelated baseline path byte-identical and unstaged.

</acceptance_criteria>

<verify>

- `nifra check --json`
- `bun run check:agent-platform-plan && bun run check:agent-platform-worktree verify --task P7-T2`
- `bun run check:agent-boundary && bun run check:agent-isolation && bun run check:public-boundary && bun run check:consumers`
- `bun run check:agent-platform-worktree generate --task P7-T2 -- bun run gen:llms && bun run check:agent-platform-worktree generate --task P7-T2 -- bun run gen:api && bun run check:agent-platform-worktree generate --task P7-T2 -- bun run gen:node-outcome && bun run check:agent-platform-worktree generate --task P7-T2 -- bun run gen:public`
- `bun run check:corpus && bun run check:public-manifest && bun run check:docs && bun run check:size && bun run check:cold-start && bun run check:changesets`

</verify>

#### Task P7-T3: Private handoff and final release gate

**Requirement IDs:** QLT-11, QLT-12
**Write allowlist:** `docs/agent-platform/public-private-handoff.md`, `packages/testing/test/private-agent-adapter-conformance.test.ts`, `.planning/agent-platform/RELEASE-EVIDENCE.md`

**Precondition:** The committed P7-T2 head passes `check:agent-platform-worktree verify`, the shared worktree has no unreviewed overlap with P7-T3 targets, and the release environment provides a non-empty `PRIVATE_MARKERS` secret.

<read_first>

- `.planning/agent-platform/REQUIREMENTS.md`
- `.planning/agent-platform/ROADMAP.md`
- `/Users/a2/PUBLIC-PRIVATE-RUBRIC.md`
- `packages/cli/src/release-verification.ts`
- `package.json`

</read_first>

<action>

Implement QLT-11 and QLT-12. Publish the public/private handoff checklist and fake private adapter conformance fixture. Require private data-layer authorization and RLS, credential handling, retention, at-least-once idempotent dispatch, reconciliation, no PII in logs, and evidence or artifact separation without describing private topology. Run focused tests in the shared worktree, then verify that changed and staged paths remain inside P7-T3's allowlist and that every unrelated baseline digest is unchanged. Create a fresh isolated linked worktree at the committed program head for the release run. In that clean worktree, assert non-empty `PRIVATE_MARKERS`, run `check:public-boundary:release`, `check:agent-platform-plan`, agent boundary and isolation gates, package consumers, corpus, performance, cross-runtime, coverage, and the existing release-equivalent command. Record command, commit, marker-presence boolean, generated-diff result, and pass or fail status in `RELEASE-EVIDENCE.md`; never record marker values. Review the final public API, migration, generated files, changesets, task-scoped diff, and public/private diff before the one-way publication checkpoint. Never stage or commit unrelated shared-worktree paths.

</action>

<acceptance_criteria>

- A fake private adapter passes public conformance and the handoff checklist without private implementation leakage.
- All 88 requirements have passing evidence in their single owner phase.
- Generated files are current and the clean-checkout release-equivalent gate succeeds.
- Human publication approval explicitly covers compatibility, privacy, public/private boundary, and package list.
- Release evidence comes from the isolated clean worktree with fail-closed marker configuration; unrelated shared-worktree diffs remain byte-identical and unstaged.

</acceptance_criteria>

<verify>

- `bun test packages/agent-protocol/test packages/agent-app/test packages/agent/test packages/coding-agent/test packages/testing/test packages/agent-telemetry/test packages/jobs/test packages/mcp/test`
- `nifra check --json`
- `bun run check:agent-platform-worktree verify --task P7-T3`
- `bun run check:agent-platform-worktree release --task P7-T3 -- bun run check:public-boundary:release`
- `bun run check:agent-platform-worktree release --task P7-T3 -- bun run check:agent-platform-plan`
- `bun run check:agent-platform-worktree release --task P7-T3 -- bun run check:release`

</verify>

## Task requirement ownership audit

| Task | Requirement IDs | Count |
| --- | --- | ---: |
| P0-T1 | ORC-01, ORC-02, ORC-03, APS-01, EVL-01, EVL-02 | 6 |
| P0-T2 | BND-01, BND-02, BND-03, BND-04, BND-05, BND-06, BND-07, BND-08 | 8 |
| P0-T3 | QLT-01 | 1 |
| P1-T1 | ORC-04, ORC-05, ORC-07, ORC-08 | 4 |
| P1-T2 | ORC-06, ORC-09, ORC-10 | 3 |
| P1-T3 | EVL-03, EVL-04, EVL-05 | 3 |
| P2-T1 | APS-02, APS-03 | 2 |
| P2-T2 | APS-04, APS-05, APS-06, APS-07, APS-08, APS-09 | 6 |
| P2-T3 | UX-01 | 1 |
| P3-T1 | REG-01, REG-02, REG-03, REG-04, REG-05, REG-08 | 6 |
| P3-T2 | REG-06, REG-07, UX-02, UX-03, UX-04 | 5 |
| P3-T3 | UX-05 | 1 |
| P4-T1 | GTW-01, GTW-02, GTW-03, GTW-04, GTW-05, GTW-06 | 6 |
| P4-T2 | DEP-01, DEP-02, DEP-03, DEP-05, DEP-07 | 5 |
| P4-T3 | GTW-07, DEP-04, DEP-06 | 3 |
| P5-T1 | JOB-01, JOB-02, JOB-03 | 3 |
| P5-T2 | JOB-04, JOB-05, JOB-06, JOB-07 | 4 |
| P5-T3 | JOB-08 | 1 |
| P6-T1 | EVL-06, EVL-07, EVL-08, EVL-09 | 4 |
| P6-T2 | UX-06 | 1 |
| P6-T3 | UX-07, UX-08, UX-09, UX-10 | 4 |
| P7-T1 | QLT-02, QLT-03 | 2 |
| P7-T2 | QLT-04, QLT-05, QLT-06, QLT-07, QLT-08, QLT-09, QLT-10 | 7 |
| P7-T3 | QLT-11, QLT-12 | 2 |
| **Union** | **All REQUIREMENTS.md IDs, each once** | **88** |

P0-T3 makes this table and the per-task `Requirement IDs` fields mechanically enforceable with `bun run check:agent-platform-plan`. The checker extracts the authoritative 88 IDs from REQUIREMENTS.md, extracts exactly 24 task fields, compares the union, rejects duplicates or unknown IDs, confirms every task has a write allowlist, confirms each phase union equals its ROADMAP requirement list, and scans REQUIREMENTS.md, ROADMAP.md, PROGRAM-PLAN.md, and RESEARCH.md for non-ASCII dash code points. The existing `.planning/NIFRA-AGENT-WORKBENCH-PLAN.md` is deliberately outside this artifact-local scan and remains unchanged.

## Artifacts produced by phase

| Phase | Required artifacts |
| --- | --- |
| P0 | Evidence and artifact contracts, `RunPlan`, tracer compiler, tracer eval, frozen compatibility fixtures, generic operated-depth deny policy, fail-closed marker wrapper, plan audit, and worktree guard |
| P1 | Full compiler, catalog, orchestration host, evidence-only stores, eval suites, rubrics, baselines |
| P2 | Protocol lifecycle additions, `@nifrajs/agent-app`, fake/replay/RPC conformance, Workbench SDK cutover |
| P3 | Common registry, core/MCP/extension projections, host admission, handoff coordinator, Workbench inbox |
| P4 | Model gateway, fake/replay routes, deployment contracts, local/CI/replay profiles, certification |
| P5 | Dispatch ports, jobs adapter, idempotency and recovery state machine, private adapter handoff fixture |
| P6 | Eval failure matrix, CI report API, correlated telemetry, run graph, timeline, eval and fault views |
| P7 | Compatibility matrix, evidence migration, security suite, checked benchmarks, isolated generation, docs, changesets, extraction gate, dirty-path preservation proof, and clean-worktree release evidence |

## Threat model

### Trust boundaries

| Boundary | Untrusted or less-trusted input | Required owner |
| --- | --- | --- |
| Run plan to orchestration host | Declarative graph, step keys, limits, policies | Protocol parser plus host policy |
| Model or provider to gateway | Structured response, errors, usage counters | Gateway parser and caller route policy |
| Tool, MCP, or extension to registry | Descriptor and schema declarations | Registry parser plus host admission |
| Agent App client to local RPC | Commands, cursors, approval or handoff decisions | RPC authentication, parser, request matching |
| Workflow to evidence sink | Runtime events and possible content-bearing values | `projectEvidence` plus strict sink parser |
| Worker to dispatch store | Lease, checkpoint, completion, retry, cancellation | Lease generation and idempotency proof |
| Deployment adapter to host | Capability claim and lifecycle callback | Certification plus host policy |
| Evidence to telemetry or Workbench | Identifiers, counters, statuses, references | Attribute and view-model allowlists |
| Public seam to private adapter | Opaque caller context and adapter implementation | Private data-layer authorization and conformance |

### STRIDE register

| Threat ID | Category | Component | Severity | Disposition | Mitigation and owner phase |
| --- | --- | --- | --- | --- | --- |
| T-AP-01 | Spoofing | Agent App command or HITL decision | High | Mitigate | Caller auth hook, loopback bearer auth, negotiated command, and run/node/request matching in P2-P3 |
| T-AP-02 | Tampering | Run plan graph or limits | High | Mitigate | Strict parsing, digest, cycle and bound validation, catalog lookup, and host admission in P0-P1 |
| T-AP-03 | Repudiation | Approval, handoff, retry, or recovery | Medium | Mitigate | Stable evidence identity, state transitions, expiry, schedule token, and digest in P3-P5 |
| T-AP-04 | Information disclosure | Public store, eval, telemetry, benchmark, or UI | Critical | Mitigate | Evidence firewall, 4 KiB cap, forbidden corpus, caller-owned artifact seam, and regression scans in P0-P7 |
| T-AP-05 | Denial of service | Oversized graph, event stream, retries, or UI history | High | Mitigate | 256-node cap, step/depth/concurrency/retry/deadline bounds, bounded queues, virtualized UI in P0-P6 |
| T-AP-06 | Elevation of privilege | Plan, child, descriptor, model, extension, or UI self-grant | Critical | Mitigate | Host-owned monotonic capability, budget, deadline, workspace, approval, and isolation vectors in P0-P4 |
| T-AP-07 | Spoofing | Provider or deployment adapter identity | High | Mitigate | Opaque registered route IDs, versioned descriptors, certification, and caller policy in P3-P4 |
| T-AP-08 | Tampering | Duplicate job, stale lease, or late completion | Critical | Mitigate | Stable idempotency key, lease generation, safe checkpoint, and convergence tests in P5 |
| T-AP-09 | Information disclosure | Legacy session migration | High | Mitigate | Transient read, strict projection, new target, source preserved, evidence-only migration report in P7 |
| T-AP-10 | Elevation of privilege | False hostile-code sandbox claim | Critical | Mitigate | Explicit isolation capability, negative local profiles, lying-adapter certification, and host rejection in P0-P4 |
| T-AP-11 | Tampering | Feature negotiation or cursor resume | Medium | Mitigate | Feature intersection, stable sequence identity, dedupe, gap detection, and resync in P0-P2 |
| T-AP-12 | Information disclosure | Private operated topology in public code | High | Mitigate | Always-on generic operated-depth implementation policy, declared disposable-reference allowlist, fail-closed CI marker configuration, sentinel fixture, and conformance-only opaque hooks in P0-P7 |
| T-AP-SC | Tampering | Package supply chain | Medium | Mitigate | No third-party install is planned; new package uses workspace protocol only, and publish/consumer/changeset gates run in P2/P7 |

## Decision reversibility and rollback

| Decision | Rating | Rationale | Rollback strategy |
| --- | --- | --- | --- |
| Additive protocol version 1 features | Costly | Public peers depend on field meaning | Disable feature advertisement; retain optional fields and legacy decoder |
| Evidence-only public reference sinks | Costly | Relaxing it later would create privacy and trust debt | Do not relax; private artifact adapters remain the escape seam |
| `coding-agent/orchestration` placement | Reversible | Internal module can move behind compatible exports after proof | Keep facade exports and move only after extraction gate |
| New `@nifrajs/agent-app` package | Costly | Published package and API require compatibility | Workbench may revert client usage; package remains supported until normal deprecation |
| Common registry descriptor | Costly | Adapter ecosystem consumes it | Version descriptors and keep adapters for prior versions |
| Gateway and deployment contracts | Costly | Optional adapters implement them | Keep interfaces stable; replace leaf adapters independently |
| At-least-once dispatch and idempotency format | Costly | Durable adapters persist keys and checkpoints | Disable durable adapter; local orchestration continues; migrate versioned records separately |
| Workbench studio views | Reversible | They consume SDK view models only | Hide negotiated feature and retain existing shell views |
| Legacy session evidence migration | Reversible | Source logs remain untouched | Point local config back to source and remove incomplete target |
| Public package publication | One-way | Published versions and migrations cannot be silently withdrawn | Blocking human release checkpoint after all gates; follow semver deprecation after publish |

## Failure injection matrix

| Boundary | Injection | Expected behavior | Owner phase |
| --- | --- | --- | --- |
| Plan parser | Duplicate ID, missing dependency, cycle, 257th node | Reject before catalog lookup with stable code | P0 |
| Evidence sink | Forbidden key, nested content, 4 KiB plus one byte, non-finite counter | Reject without partial append | P0 |
| Authority | Child adds capability, extends deadline, expands workspace, raises budget | Deny before execution | P0-P1 |
| Workflow | Step throws, verification false, retry exhausted, cancellation during parallel branch | One legal terminal state and bounded evidence | P1 |
| Eval | Duplicate case, invalid rubric, missing baseline, seeded regression | Deterministic reject or failing report | P1/P6 |
| Stream | Duplicate, reorder, disconnect, stale cursor, transient overflow | Dedupe or explicit resync; no silent gap | P2 |
| HITL | Expiry, duplicate resolution, wrong run/node, late decision | Deny or expire closed; no unrelated resume | P3 |
| Registry | Collision, schema drift, undeclared capability, unknown kind | Reject snapshot or activation | P3 |
| Gateway | Malformed success, refusal, timeout, rate limit, non-retryable error, exhausted budget | Parse and stop or explicit allowed fallback | P4 |
| Deployment | Prepare failure, start timeout, cancel race, dispose failure, false isolation | Bounded cleanup and failed certification | P4 |
| Jobs | Duplicate delivery, crash before or after effect, crash after checkpoint, expired lease, late completion | Converge with idempotency proof and lease generation | P5 |
| Telemetry | Content attribute, high-cardinality ID misuse, oversized value | Reject or drop with bounded counter | P6 |
| Workbench | 100k evidence events, graph cycle fixture, unsupported feature | Bounded memory/DOM, explicit safe state | P6 |
| Migration | Corrupt line, interruption, forbidden payload, invalid output digest | Source untouched and no config switch | P7 |

## Test pyramid

| Layer | Purpose | Required coverage |
| --- | --- | --- |
| Type and parser fixtures | Prove public contracts and dependency direction | All protocol, plan, evidence, registry, gateway, dispatch, eval, and deployment values |
| Property tests | Explore graphs, authority vectors, evidence keys, cursors, schedules, and budgets | Cycle and bound rejection, monotonic delegation, deterministic ordering, no content serialization |
| Unit tests | Exercise each state machine and pure policy | Compiler, catalog, lifecycle, HITL, gateway, lease, migration, view-model reducers |
| Contract and certification | Hold adapters to one behavior | Fake/replay/RPC client, registry projections, gateway, dispatch, deployment, fake private adapter |
| Fault-injection integration | Prove recovery and convergence | Every row in the failure matrix with fixed seed and schedule token |
| End-to-end tracer and Workbench | Prove vertical user capability | Declarative run, approval/handoff, retry/recovery, eval comparison, replay UI |
| Consumer and cross-runtime | Prove packages ship independently | Agent App SDK, protocol, agent, testing, coding-agent subpaths, applicable Node/Deno consumers |
| Release-equivalent | Prove repository integrity | Boundary, isolation, corpus, docs, coverage, size, cold start, performance, changesets, `check:release` |

## CI and release gates

### Per-task gate

- Capture or verify the dirty-path and digest baseline, enforce the task `Write allowlist`, and stop on overlap before mutation. P0 tasks use direct Git status and digest checks until P0-T3 installs the helper; all later tasks run `bun run check:agent-platform-worktree verify --task <task-id>`.
- Run the focused Bun test files listed in the task.
- Build each touched package with `bun run --filter '<package>' build`.
- Run `nifra check --json` when a task changes an application or public contract surface.
- Run `bun run check:agent-boundary` for any dependency or export change.
- Run `bun run check:agent-isolation` for any agent runtime, Workbench, process, registry, gateway, dispatch, or deployment change.
- After P0-T3, run `bun run check:agent-platform-plan`; before commit, compare changed and staged paths to the active allowlist and stage exact paths only.

### Per-phase gate

- All focused tests for the phase.
- `nifra check --json`.
- `bun run check:agent-platform-plan` and the phase-union worktree allowlist check.
- `bun run check:public-boundary` when public/private or package topology changes.
- `bun run check:consumers` for new or changed public exports.
- Relevant evidence, orchestration, gateway, recovery, replay, Workbench, size, cold-start, or performance benchmark.
- `nifra assure --json` only when the execution fixture has `nifra.assurance.ts`; configured assurance failure is blocking.

### Final gate

1. `bun test packages/agent-protocol/test packages/agent-app/test packages/agent/test packages/coding-agent/test packages/testing/test packages/agent-telemetry/test packages/jobs/test packages/mcp/test`
2. `nifra check --json`
3. `bun run check:agent-boundary`
4. `bun run check:agent-isolation`
5. `bun run check:agent-platform-plan`
6. `bun run check:public-boundary:release` with non-empty `PRIVATE_MARKERS`
7. `bun run check:consumers`
8. Generated files produced by the P7 isolated-generation path, followed by `bun run check:corpus && bun run check:public-manifest && bun run check:docs`
9. `bun run check:size`
10. `bun run check:cold-start`
11. `bun run check:workbench-agent` plus applicable checked agent, replay, and gateway performance modes
12. `bun run check:coverage`
13. `bun run check:changesets`
14. `bun run check:release`

The final gate runs through `check:agent-platform-worktree release` in a fresh linked worktree at the committed program head. A dirty shared worktree, even when its changes are unrelated, is never used as release evidence.

## Performance budgets

These are checked phase gates on the repository reference machine, not cross-hardware marketing promises. Reports contain evidence only.

| Surface | Budget | Gate owner |
| --- | --- | --- |
| Run-plan compile | p95 at most 10 ms for 256 valid nodes; memory linear in node and edge count | P1 |
| Local schedule overhead | p95 at most 2 ms per no-op node excluding user work | P1 |
| Evidence projection | p95 at most 1 ms per event; serialized record at most 4 KiB | P0 |
| Event stream | Bounded queue and live window at 1k, 10k, and 100k events; transient drops counted | P0-P1 |
| Agent App SDK | No provider, UI, desktop, storage, or coding-agent dependency; bounded reconnect buffer | P2 |
| Gateway | Mediation overhead at most 5 percent over injected fake model call; no hidden retry | P4 |
| Replay and eval | 1,000 deterministic steps at most 250 ms excluding user code, network, and real tools | P6 |
| Workbench render | p95 evidence event to render at most 16 ms | P6 |
| Workbench ready | Orchestration view usable at most 1 second after local RPC ready | P6 |
| Workbench history | Virtualized after 1,000 rows with bounded DOM and memory at 100k events | P6 |
| Existing framework | No agent-package dependency, size, or cold-start regression in bare core/client/web consumers | P7 |

No performance optimization may retain raw content for debugging.

## Security and privacy invariants

1. Parse every trust boundary before use.
2. Evidence sinks accept only the allowlist and reject unknown nested values.
3. Public reference code never persists payload content or accumulated intelligence.
4. Artifact content is caller-owned and optional; opaque references are the public seam.
5. Host policy owns capability, budget, deadline, workspace, approval, and isolation authority.
6. Delegation is monotonic for all child work and adapters.
7. Approval and handoff expiry fails closed.
8. RPC remains loopback-only and authenticated by default; remote exposure is not introduced.
9. Provider and deployment routes never load public credentials or pricing policy.
10. Durable adapters authorize at the private data layer; durability never substitutes for authorization.
11. Dispatch is at least once with stable idempotency keys and lease generation checks.
12. Local process, runner, replay, and extension worker are never hostile-code sandboxes.
13. Telemetry is off by default and content-free when enabled.
14. Workbench production UI uses SDK projections, not session files or backend internals.
15. Protected framework packages remain free of agent-platform imports.

## Public/private handoff checklist

A private operated adapter is conformant only when all answers are yes:

- [ ] Implements the public port without adding private types to public packages.
- [ ] Parses all callbacks and evidence at the boundary.
- [ ] Enforces subject and tenant authorization at the data layer.
- [ ] Creates RLS and tenant partitioning with the first persisted schema.
- [ ] Stores credentials in a private vault and never returns them in evidence or errors.
- [ ] Defines retention, deletion, backup, and incident policy for any content.
- [ ] Separates evidence metadata from caller-owned artifact content.
- [ ] Implements at-least-once dispatch with stable public idempotency keys and private reconciliation.
- [ ] Prevents stale leases and late completions from overwriting newer state.
- [ ] Keeps pricing, billing, spend enforcement, entitlements, and cost attribution private.
- [ ] Keeps notifications, hosted discovery, remote fleet control, and managed deployment private.
- [ ] Emits no PII, prompt, model text, tool payload, response body, credential, or raw diagnostic to logs.
- [ ] Passes the applicable public certification and failure schedules.
- [ ] Documents runtime and isolation capabilities truthfully.
- [ ] Does not expose private workspace topology, product names, or internal APIs in public fixtures.

## Risk register

| Risk | Trigger | Mitigation | Owner phase |
| --- | --- | --- | --- |
| Privacy regression from existing content-bearing events | A new sink accepts `AgentEvent` directly | Type sinks to `RunEvidence`, add projector and forbidden corpus, block direct import | P0 |
| Duplicate orchestration engine | Compiler begins scheduling instead of producing `WorkflowStep` | Parity tests and source ownership check; stop phase | P0-P1 |
| Protocol fragmentation | Existing field meaning changes or client needs version branch | Additive optionals, feature intersection, frozen fixtures | P0/P2/P7 |
| Agent App SDK coupling | SDK adds coding-agent, Pi, React, storage, or identity | Protocol-only manifest and isolated consumer gate | P2 |
| Registry becomes execution runtime | Descriptor adapter invokes a tool or owns MCP transport | Keep invocation with current owners and test dependency direction | P3 |
| Authority escalation | Child or descriptor widens a parent vector | Property tests and host admission before work | P0-P4 |
| Silent provider fallback | Route changes without declared code or evidence | Explicit route policy and terminal tests | P4 |
| False sandbox confidence | Local adapter claims hostile isolation | Negative capability, lying-adapter certification, hostile fixture rejection | P0/P4 |
| Duplicate external side effect | Crash or lease expiry repeats work | Stable idempotency proof, safe checkpoints, lease generation | P5 |
| Public durability creep | Adapter needs tenant, retention, or fleet details | Stop and move implementation to private operated layer | P5/P7 |
| Eval becomes opaque score or corpus store | Report includes free text, example, raw trajectory, or single aggregate score | Strict report parser, explicit invariants and rubrics, boundary scan | P0/P1/P6 |
| Observability leaks content or explodes cardinality | New attribute accepts arbitrary text or IDs | Allowlist, caps, tests, dropped counter | P6 |
| Workbench backend coupling | UI imports Pi/native/session store | Agent App SDK dependency scan and replay smoke | P2/P6 |
| Legacy migration destroys data | In-place rewrite or partial target activation | New target, source untouched, validate before switch, rollback test | P7 |
| Premature orchestrator extraction | Package proposed without second consumer | Recorded extraction gate and dependency analysis | P7 |
| Release drift | Docs, generated corpus, exports, or changesets disagree | Corpus, API, consumer, changeset, and release-equivalent gates | P7 |
| Concurrent-change clobber | A task or generator touches a pre-existing dirty or out-of-allowlist path | Baseline path digests, task or phase allowlists, overlap stop, exact staging, isolated generation and release worktrees | P0-P7 |
| Boundary gate silently weakens | Marker scan is skipped or an operated implementation avoids private names | Always-on generic policy, fail-closed CI or release markers, positive and negative fixtures | P0/P7 |

## Documentation, release, and migration deliverables

- `packages/agent-protocol/README.md`: evidence, run lifecycle, features, cursor, and compatibility.
- `packages/agent-app/README.md`: client construction, caller auth, reconnect, feature negotiation, safe view models, fake/replay usage.
- `packages/coding-agent/README.md`, `SECURITY.md`, `PERFORMANCE.md`, and `REGISTRY.md`: orchestration, dispatch, evidence stores, limitations, benchmarks, and registry ownership.
- `packages/agent/README.md`: gateway, registry, deployment contracts, budget and fallback policy, optional leaf adapters.
- `packages/testing/README.md`: eval suites, rubrics, baseline comparisons, certification, failure schedules, report privacy.
- `packages/jobs/README.md`: unchanged generic ownership plus coding-agent adapter reference and at-least-once clarification.
- `packages/agent-telemetry/README.md`: safe correlation allowlist, disabled default, cardinality bounds.
- `apps/workbench/README.md`: SDK dependency, fake/replay modes, run graph, inbox, timeline, eval views, UI budgets.
- Public migration guide: protocol version 1 negotiation, old/new matrix, session evidence migration, rollback.
- Public/private adapter guide: conformance checklist only, with no private topology or product naming.
- Changesets for every changed public package and the new Agent App SDK.
- Regenerated API reference, LLM cards, node outcome, and public product manifest as required by existing scripts.

## Orchestrator extraction gate

`@nifrajs/orchestrator` must not be created during this program. Extraction may be proposed only when both conditions are already true:

1. A second production consumer outside `@nifrajs/coding-agent` uses the compiler, catalog, and orchestration host contracts for real work.
2. A recorded dependency analysis shows extraction removes at least one unwanted dependency or cycle and reduces coupling compared with the current subpath facade.

The proposal must include actual consumer imports, current and proposed dependency graphs, package size and cold-start effects, protocol ownership, migration path, and proof that it does not create a second executor. Reuse by tests, Workbench, examples, a private adapter, or a speculative future product does not count as the second production consumer.

If both conditions are not present, keep the code at `@nifrajs/coding-agent/orchestration`.

## Definition of Done

The Agent Platform program is done when:

- [ ] All 88 requirements are verified in exactly their ROADMAP owner phase.
- [ ] All 24 tasks have non-empty `Requirement IDs` and `Write allowlist` fields; the mechanical audit reports 88 unique owners, zero missing IDs, zero duplicate IDs, and zero non-ASCII dash characters in the four agent-platform artifacts.
- [ ] The phase-0 tracer remains green through final release.
- [ ] Declarative plans compile into the existing `WorkflowRunner`; no duplicate executor exists.
- [ ] Agent evals compose existing replay, failure, idempotency, contract, and certification owners.
- [ ] `@nifrajs/agent-app` is the only new initial public package and depends only on protocol.
- [ ] Protocol version 1 legacy and negotiated compatibility matrices pass.
- [ ] Every new public reference sink and report is evidence-only and capped.
- [ ] `FileSessionStore` legacy compatibility and evidence migration are tested and documented.
- [ ] Host-owned monotonic authority and expiring-closed HITL behavior pass property and integration tests.
- [ ] Gateway fallback is explicit and deployment isolation claims are certified truthfully.
- [ ] At-least-once recovery converges under every required injected failure.
- [ ] Workbench uses SDK and replay/fake backends without production backend internals.
- [ ] Performance budgets pass on the recorded reference machine.
- [ ] Public/private handoff conformance passes without operated-depth code in public packages.
- [ ] The generic operated-depth policy, fail-closed CI marker precondition, configured sentinel scan, and release marker wrapper pass their positive and negative fixtures.
- [ ] Every unrelated baseline path remains byte-identical and unstaged; generation and release evidence come from isolated clean linked worktrees.
- [ ] `nifra check --json`, focused Bun tests, boundary and isolation checks, consumers, corpus, docs, coverage, performance, changesets, and `bun run check:release` pass.
- [ ] The release checkpoint approves compatibility, privacy, public/private boundary, migrations, package list, and generated diffs.
- [ ] No `@nifrajs/orchestrator` package exists unless the recorded extraction gate was already satisfied.

## Requirement coverage audit

| Phase | Requirement IDs | Count | Coverage |
| --- | --- | ---: | --- |
| P0 | BND-01 through BND-08; ORC-01 through ORC-03; APS-01; EVL-01 through EVL-02; QLT-01 | 15 | Complete |
| P1 | ORC-04 through ORC-10; EVL-03 through EVL-05 | 10 | Complete |
| P2 | APS-02 through APS-09; UX-01 | 9 | Complete |
| P3 | REG-01 through REG-08; UX-02 through UX-05 | 12 | Complete |
| P4 | GTW-01 through GTW-07; DEP-01 through DEP-07 | 14 | Complete |
| P5 | JOB-01 through JOB-08 | 8 | Complete |
| P6 | EVL-06 through EVL-09; UX-06 through UX-10 | 9 | Complete |
| P7 | QLT-02 through QLT-12 | 11 | Complete |
| **Total** | **Every in-scope ID exactly once** | **88 / 88** | **100%** |

No research feature, locked architecture decision, or in-scope user capability is unplanned. Future and out-of-scope items remain explicitly excluded in REQUIREMENTS.md.
