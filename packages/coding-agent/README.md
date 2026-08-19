# @nifrajs/coding-agent

Standalone, extensible Nifra coding-agent host and CLI.

The package provides `nifra-agent` in interactive, one-shot, JSON, and local
loopback RPC modes. It adds sessions, checkpoints, bounded compaction,
transactional TypeScript extensions, self-healing repair stages, workflows,
bounded subagents, and Nifra verification descriptors without changing Nifra's
framework runtime.

Extensions can register bounded workflows that are listed and run through the
authenticated RPC surface. Capability manifests, project workspace policies,
optional isolated-worktree leases, and a pre-activation syntax gate keep those
customizations explicit and replaceable.

```sh
bunx nifra-agent --backend pi
bunx nifra-agent --backend pi --message "run the checks and explain failures"
bunx nifra-agent --backend replay --replay ./session-events.jsonl --json
```

For embedding, use `CodingAgentHost` or `CodingAgentRpcServer`. The host keeps
live event queues bounded, filters verification subprocess environments, and
requires explicit local RPC authorization. Install this package only when an
application wants the agent product.

`IsolatedExtensionWorker` is an opt-in process-backed crash-containment seam for
extensions. It is not a hostile-code sandbox; use OS-level isolation before
loading code you do not trust.

`NifraBackend` is a small provider port for a future native backend. It accepts
an injected model implementation and bounded tools without importing a provider
SDK. `ReplayBackend` and `readReplayEvents` provide deterministic protocol
replays for CI and Workbench regression tests.

For AI agents, see [`LLM.md`](./LLM.md) and the full corpus
[`../../llms-full.txt`](../../llms-full.txt).
