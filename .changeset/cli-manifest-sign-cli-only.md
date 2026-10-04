---
"@nifrajs/cli": patch
---

`nifra manifest emit --sign <keyId>` is available only from the CLI. The `nifra_manifest` MCP tool no longer lists `sign` in its input schema and answers a call that passes it with `{ ok: false, error: "sign is available only from the nifra CLI" }`, so an agent cannot ask the operator's `manifest.signer` callback to sign a manifest. Commands declare such fields with the new `cliOnlyFields` on their spec; the catalog entry carries them, and `commandMcpInputSchema()` gives the schema an MCP tool advertises.
