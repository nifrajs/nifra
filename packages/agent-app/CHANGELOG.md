# @nifrajs/agent-app

## 4.0.1

### Patch Changes

- @nifrajs/agent-protocol@4.0.1

## 4.0.0

### Patch Changes

- 930ed0d: `AgentAppClient.send()` delivers every turn, not only the first. The client advances `session.lastSeq` as it yields each event, and the next turn's ordering buffer starts after it. Previously a second turn's events waited behind a gap that never filled, and the turn yielded nothing.
- db9d1e1: The view models hold their input to one shape:

  - `boundaryIsStale` treats an expiry or a clock that is not a number as stale, so `boundaryCommands` offers no command for that boundary.
  - `toRunStudioView` refuses a run graph that lists the same node twice, instead of rendering it twice and counting it twice.
  - `toReviewView` reads the `report` inside a host result as a review report only. A host result nested inside another projects as the `invalid-report` unavailable view. Duplicate finding ids are checked in linear time, so a report at the 4,096-finding cap parses in about 5 ms instead of 22 ms.

- ef28ef9: Run views list nodes, checks and findings in code-unit order of their ids, the same in every locale.
  - @nifrajs/agent-protocol@4.0.0

## 3.5.0

### Patch Changes

- 6430334: Add the provider-neutral, content-free review report contract and expose `nifra review` through the CLI, authenticated agent RPC, and Workbench-safe view projections.
  - @nifrajs/agent-protocol@3.5.0

## 3.4.0

### Patch Changes

- 8d23613: Add the opt-in `@nifrajs/webmcp` package: typed WebMCP registration, core-backed receipts, deterministic predictive-UI reconciliation, and host-independent conformance checks. Also tighten agent execution cancellation cleanup so aborted local work cannot leak into later turns.
- Updated dependencies [8d23613]
  - @nifrajs/agent-protocol@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/agent-protocol@3.3.0

## 3.2.0

### Patch Changes

- 1a041a9: Add provider-neutral gateway and deployment contracts with deterministic reference adapters and evidence-safe policy checks.
- Updated dependencies [e3e197b]
  - @nifrajs/agent-protocol@3.2.0
