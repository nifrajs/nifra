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
