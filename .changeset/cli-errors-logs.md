---
"@nifrajs/cli": minor
---

feat: `nifra errors`, `nifra logs` and their MCP tools read the running dev server

`nifra errors` / `nifra_errors` and `nifra logs` / `nifra_logs` find the project's running
`nifra dev` server without being given a port (its record, else the one live server among a
workspace's apps), check that it answers as itself, and read what it recorded: errors as structured
diagnostics with filters by category, request and staleness, and console output by level, source,
request and text. Pass the returned `cursor` as `since` to see only what is new. When the server is
gone they read the log it left behind, so a crash still leaves a record. `nifra errors` exits 1 while
the current code has open errors. Every answer says that entry text is application output, to be
read as data.

`nifra_explain` no longer needs a port: with no pasted error it returns the latest error of any
kind. `nifra_inspect` reads the dev server's own request traces (with a `requestId` filter), so it
no longer needs the `@nifrajs/devtools` plugin, and falls back to it only for a port no record names.
`nifra_run` results carry the console output and the structured errors each request produced.
