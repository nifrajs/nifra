# Nifra Workbench

The Workbench is a dependency-light local browser client for `nifra-agent`. It uses the same
versioned agent protocol over a token-authenticated loopback JSON/SSE RPC server.

```sh
bun run --filter '@nifrajs/workbench' dev -- --cwd /path/to/project
```

The launcher prints a one-time local URL. Desktop packaging (Tauri) can wrap this client after the
local web surface is stable; the browser client is intentionally usable by itself for fast iteration.

The shell also discovers workflow extensions and controlled UI manifests through
the same RPC connection. Workflow execution remains bounded by the host, and
the navigation, approval, and security surfaces stay owned by the stable shell.

## Capability registry and decision inbox

The inspector surfaces two host-owned control planes, both driven only by the
content-free view models in `@nifrajs/agent-app`:

- **Capability registry** lists each admitted capability as an identity card:
  kind, name, version, schema digest, required capability tokens, and the
  approval, retry, idempotency, and isolation classes. No input schema,
  description, or other content field is ever shown.
- **Decision inbox** lists pending approvals and handoffs by their structural
  coordinate (run, node, capability, child vector, request id, expiry) and
  lifecycle state. Approve, deny, assign, resolve, and cancel controls appear
  only when the host has negotiated the `inbox` feature and the op is a legal
  transition from a boundary that has not expired. Every command carries the
  boundary's exact coordinate, so a decision can only ever resolve the one item
  it names; a stale, mismatched, or expired decision is refused by the host.

Both surfaces degrade to a stable notice when the host offers neither, so the
shell stays usable when the agent backend is unavailable. Neither renders a
prompt, a free-text reason, tool data, model output, a diagnostic, or an
artifact.
