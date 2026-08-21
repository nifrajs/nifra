# Agent Platform security and release hardening

The public agent layer is evidence-safe and host-authoritative. Parsers reject unknown structural
fields and forbidden content keys. Capability admission cannot widen the host ceiling. Approval and
handoff coordinates include the exact run, node, capability, request, vector, and expiry; mismatches,
replays, and decisions at expiry fail closed. Workspace paths are bounded and symlink escapes are
rejected. Local RPC is loopback-only unless a caller explicitly opts into remote binding and still
provides authentication.

Public reference adapters are disposable memory, local-file, fake, replay, or CI profiles. They do
not provide hosted durability, tenancy, RLS, retention, credentials, pricing, fleet management, or
hostile-code isolation. A capability report that claims contradictory limits or OS isolation is
rejected. Credential-shaped fields are redacted before local session evidence is written, and public
evidence, telemetry, eval reports, and Workbench view models reject payload content.

Release hardening covers:

- strict focused security regressions and deterministic failure-matrix schedules;
- boundary, dependency-direction, package consumer, size, cold-start, corpus, API, changeset, and
  cross-runtime checks;
- isolated linked-worktree generation with allowlisted output application and baseline digest checks;
- isolated release verification with non-empty marker configuration, without recording marker values;
- explicit public/private conformance and the recorded future orchestrator extraction gate.

The release command is evidence only. Publication remains a one-way human approval checkpoint.
