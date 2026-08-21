# Public/private adapter handoff

This document is the release boundary for operated adapters. The public Nifra packages provide
stable, provider-neutral ports and content-free evidence. An adapter may add operated depth behind
those ports, but it must not widen the public package or make public evidence carry payloads.

## Handoff checklist

Before an adapter is activated in a production environment, its owner must provide evidence for
each item below. The evidence may be private; this public document records the obligation, not the
implementation or deployment layout.

### Authorization and data-layer policy

- Every enqueue, lease, inspect, settle, read, and write is authorized for the caller and operation.
- Authorization is denied by default and is checked again at the data layer.
- Row-level authorization is enforced by the data store for every tenant-scoped read and write. An
  application-only filter is not sufficient evidence of isolation.
- The adapter cannot widen the host capability, workspace, deadline, or cancellation policy.

### Credentials

- Credentials are obtained only at the private integration edge, with least privilege and a bounded
  lifetime.
- Credentials never appear in dispatch records, evidence, artifacts, exceptions, metrics, or logs.
- Rotation and revocation are tested, and a missing or expired credential fails closed.

### Retention and evidence

- Retention is explicit, bounded, and tested for deletion or expiry.
- Dispatch and evidence records contain only identifiers, digests, counters, stable codes, timestamps,
  lease generations, and idempotency keys.
- Payloads, prompts, transcripts, tool inputs or outputs, response bodies, and credentials are not
  stored in a public sink. Caller-owned artifact references remain opaque and are not dereferenced by
  the public runtime.

### At-least-once delivery and reconciliation

- Delivery is documented as at-least-once. No exactly-once guarantee is implied.
- A retry or duplicate delivery uses a stable idempotency key. An effect is not skipped after a
  crash-after-effect unless the adapter has a matching committed proof.
- Lease generations and compare-and-commit rules reject late workers.
- Reconciliation can identify missing or divergent evidence and converge without overwriting a newer
  lease or rerunning an unproven effect.

### Logging and operations

- Logs use an allowlisted, content-free schema and are checked for PII, secrets, payloads, and stack
  details before emission.
- Health, cancellation, retry, dead-letter, and reconciliation outcomes are observable through safe
  codes and counters.
- Failure, timeout, unavailable credential, and denied authorization paths fail closed and leave a
  recoverable evidence trail.

## Conformance evidence

The fake private adapter in
`packages/testing/test/private-agent-adapter-conformance.test.ts` is deliberately disposable. It
checks the public port shape, fail-closed authorization, data-layer policy hooks, transient secret
handling, retention, stable idempotency across duplicate delivery, late-lease rejection,
reconciliation, and content-free evidence. Passing this fixture is necessary but not sufficient for
production approval: real adapters must additionally attach their private authorization, RLS,
credential, retention, and reconciliation evidence without publishing the implementation.

## Release boundary

The release reviewer must approve compatibility, privacy, the public API, generated artifacts,
changesets, and this public/private diff before publication. This repository does not provide hosted
durability, tenant identity, credential distribution, retained payload storage, fleet control, or
exactly-once execution.
