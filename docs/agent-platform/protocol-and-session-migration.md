# Protocol and local session migration

Nifra keeps the agent protocol at version 1. Compatibility is additive: newer hosts may advertise
new features and optional fields, but they retain the meaning of existing fields and events. A
client must negotiate a feature before sending its command. An unsupported command is reported as
`feature_unsupported`; it is not treated as a transport failure. A cursor gap is reported as
`resync_required` so a client never guesses across an evicted record.

The compatibility matrix is:

| Client | Host | Behavior |
| --- | --- | --- |
| old v1 | new v1 | legacy fields/events retain their meaning; additive fields are ignored |
| new v1 | old v1 | legacy commands work; unsupported features are reported and not sent |
| new v1 | new v1 | the intersection of advertised and requested features is granted |

## Migrating a local session

`FileSessionStore` remains available for explicit local compatibility. Its JSONL files can contain
sensitive local content and are never a hosted or shared control-plane store. The migration reads
one legacy file transiently and writes a separate evidence-only JSONL file. The target contains only
the session ID, sequence, timestamp, stable event code, count, pin flag, and integrity digests;
legacy payloads, prompts, tool arguments, model output, and filesystem paths are not copied.

```sh
bunx nifra-agent --migrate-session session-1 \
  --migrate-from ./sessions/events \
  --migrate-to ./sessions/evidence \
  --json
```

The command refuses overlapping source and target roots, malformed or non-monotonic source logs,
existing targets, and aborted migrations. It validates the complete target after the atomic commit
and prints a report containing counts, sequence bounds, stable replacement-code counts, and the
target digest. The source is not rewritten, deleted, or renamed.

The command does not change a host configuration pointer. After reviewing the report, a local
operator may explicitly select the new evidence directory. Rollback is the reverse configuration
choice: point the host back to the untouched legacy directory and remove or quarantine the new
target. A failed or interrupted migration leaves the active choice unchanged.

## Future protocol majors

This program does not authorize protocol version 2. A future major requires a recorded semantic
incompatibility that cannot be represented by an additive v1 feature, dual decoders, cross-version
golden fixtures, migration and rollback documentation, and explicit release approval. Until those
conditions exist, `AGENT_PROTOCOL_VERSION` stays `1`.
