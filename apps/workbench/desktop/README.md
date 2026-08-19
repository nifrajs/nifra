# Nifra Workbench desktop shell

This directory is an optional Tauri shell for the lightweight Workbench client.
The browser client and loopback RPC remain the product surface; Tauri only adds
native windowing and lifecycle management. It does not add a dependency to any
Nifra framework package.

## Development

1. Start the Workbench server from the repository root:

   ```sh
   bun run apps/workbench/src/server.ts --cwd . --ui-port 62419 --rpc-port 62418
   ```

2. Set `NIFRA_WORKBENCH_URL` to the printed URL and run `cargo tauri dev` from
   `apps/workbench/src-tauri`.

For a packaged build, provide a signed `nifra-workbench` sidecar or set
`NIFRA_WORKBENCH_COMMAND` to a trusted launcher. The desktop shell intentionally
does not download runtimes, extensions, or model providers.

## Security boundary

The shell loads only a loopback Workbench URL, keeps the RPC bearer token in the
local launcher URL, and never exposes a remote listener by default. Production
packaging should replace the development URL with a sidecar supervisor that
passes the token out-of-band rather than persisting it in app state.
