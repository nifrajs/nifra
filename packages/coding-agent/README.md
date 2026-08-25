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

RPC failures return actionable bounded error messages by default. For a trusted
loopback debugger, set `exposeErrorStacks: true` (or pass
`--expose-error-stacks` to `nifra-agent --rpc`) to include bounded exception
stacks. This option is rejected for remote binding.

`IsolatedExtensionWorker` is an opt-in process-backed crash-containment seam for
extensions. It is not a hostile-code sandbox; use OS-level isolation before
loading code you do not trust.

`NifraBackend` is a small provider port for a future native backend. It accepts
an injected model implementation and bounded tools without importing a provider
SDK. `ReplayBackend` and `readReplayEvents` provide deterministic protocol
replays for CI and Workbench regression tests.

## At-least-once run dispatch

`@nifrajs/coding-agent/orchestration` also exports an evidence-only run dispatch port and an adapter
over `@nifrajs/jobs`. Dispatch is at-least-once: a lease may be delivered again after worker loss or
lease expiry. Every logical node attempt receives a stable idempotency key derived from the plan,
run, node, and attempt boundary. Effects must provide a matching proof before recovery can settle a
completed boundary; an unproven post-effect failure is dead-lettered rather than guessed safe.

`createMemoryRunDispatchStore()` is disposable single-process test infrastructure. It makes no
durability, hosted-worker, retention, tenant-authorization, or exactly-once guarantee. Durable
operated adapters implement the exported `RunDispatchStore` and `DurableDispatchAdapter` ports in
their own data layer, including authorization, row policy, retention, reconciliation, and worker
health. The public package does not store prompts, model output, tool arguments, or job payloads in
its dispatch evidence.

Legacy `FileSessionStore` files remain supported for explicit local compatibility. Use
`nifra-agent --migrate-session <id> --migrate-from <legacy-dir> --migrate-to <evidence-dir>` to
create a separately validated, evidence-only target. The source is left untouched and the command
does not switch an active configuration pointer; see
[`docs/agent-platform/protocol-and-session-migration.md`](../../docs/agent-platform/protocol-and-session-migration.md)
for rollback and protocol compatibility details.

For AI agents, see [`LLM.md`](./LLM.md) and the full corpus
[`../../llms-full.txt`](../../llms-full.txt).
