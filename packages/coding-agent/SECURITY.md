# Nifra agent security model

The preview is local-first and fail-closed:

- RPC binds to loopback and requires a random bearer token; remote binding is opt-in.
- Project extensions are explicit, path-bounded, syntax-checked, capability-checked, and
  transactionally reloaded.
- Session evidence is bounded, redacted for secret-shaped keys, and written as append-only JSONL.
- Tool approvals are host-owned and auditable. A workflow or subagent cannot raise its own limits.
- Subagents can be restricted to project roots or a caller-provided isolated-worktree lease.
- The isolated extension worker contains crashes but is not a hostile-code sandbox. Use OS-level
  isolation before loading code that is not trusted.
- No telemetry, hosted state, remote credentials, or model-provider SDK is required by the
  framework packages.

The capability manifest is a public declaration seam, not a sandbox by itself. Operators must pair
it with OS policy, a sandbox, or an approval broker appropriate to the deployment.

## Release regression coverage

The security suite fails closed for the following named boundaries: strict plan and evidence parsing,
capability and child-authority escalation, approval and handoff expiry, workspace and symlink escape,
content-bearing evidence, unauthorised remote RPC binding, contradictory adapter capability claims,
false hostile-code isolation claims, and credential-shaped values in logs. Stable failure codes are
asserted at each boundary. Local process and replay deployment profiles explicitly report that they
are not hostile-code sandboxes.

Legacy session migration is a separate local operation. It validates source records, writes only
structural evidence to a new target, rejects overlapping roots and existing targets, validates the
committed file, and never rewrites the source. See the public migration guide for rollback.
