---
"@nifrajs/cli": patch
---

`nifra sync-manifest` fails when `routes/` does not build a route table, such as a duplicate route or
two routes of one shape that share a path. It prints the error under the manifest's file name, leaves
the manifest untouched, and exits with status 1, where it used to report that no generated
server-manifest.ts was found and exit 0. The `nifra_sync_manifest` MCP tool answers `ok: false` with
the error on that manifest's result, and the `manifest.sync` fix recipe refuses with the same error.
The command also prints one line per manifest: synced (with added and removed routes), already in
sync, or refused.
