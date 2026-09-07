# Nifra security, correctness, and performance audit

Date: 2026-08-28
Status: Remediations implemented and verified in the current working tree. Findings F-01 through
F-17 are closed. This report describes the code as it exists in this working tree; it is not a
substitute for reviewing and promoting the changes to a release or for validating production
configuration.

## Scope and threat model

This pass covered the current framework, agentic UI and backend additions, WebMCP/MCP transports,
agent protocol and clients, Workbench, session/replay storage, framework Content adapters,
subprocess boundaries, examples, generated machine surfaces, and the repository's release gates.
The review treated HTTP/MCP input, browser messages, SSE frames, model/provider output, persisted
session records, tool arguments, and diagnostics as untrusted unless an explicit trust boundary
said otherwise.

The local subprocess adapter, local reference stores, and branded HTML constructor are contracts
for application code, not security boundaries by themselves. Operators must still apply process,
filesystem, tenant, authentication, CSP, and network isolation appropriate to their deployment.

## Executive summary

The audit found no confirmed critical or high-severity production vulnerability. The identified
protocol, cancellation, lifecycle, retention, credential-handling, and API-footgun issues were
fixed with regression coverage and bounded behavior. The release-equivalent repository gate,
focused regression suite, performance tests, memory soak, dependency scans, secret scan, and
targeted static security scan are green or clean.

The most important hardening now present is defense in depth at the trust boundaries:

- MCP HTTP validates JSON-RPC envelopes and bounds request bodies, responses, and SSE frames.
- MCP request state can be shared across authenticated requests so cancellation reaches the
  request it names; request entries are removed on settlement.
- Agent events are validated as a bounded discriminated union before projection.
- Model, tool, Pi, native, workflow, SSE, prediction, and replay paths have explicit cancellation
  cleanup and current-turn ownership checks.
- Session logs have entry, count, and byte bounds with tail-oriented reads.
- Raw HTML is no longer accepted by Content adapters as an ordinary string: callers must make the
  trust decision explicit with TrustedHtml/SanitizedHtml.
- Workbench bootstrap tokens use a fragment and are removed from browser history immediately.

## Findings at a glance

| ID | Severity | Status | Area |
| --- | --- | --- | --- |
| F-01 | Medium | Remediated | JSON-RPC envelope validation |
| F-02 | Medium | Remediated | Cross-request MCP cancellation |
| F-03 | Low | Remediated | MCP authorization failure containment |
| F-04 | Medium | Remediated | Pi stale abort listeners |
| F-05 | Medium | Remediated | Native stale abort listeners |
| F-06 | Medium | Remediated | Late native model output |
| F-07 | Low | Remediated | Workflow retry listener lifetime |
| F-08 | Low | Remediated | Workflow nesting depth |
| F-09 | Medium | Remediated | Agent-event validation |
| F-10 | Medium | Remediated | CRLF SSE parsing |
| F-11 | Low | Remediated | Early SSE consumer cancellation |
| F-12 | Medium | Remediated | Session retention and tail reads |
| F-13 | Medium, conditional | Remediated | Raw HTML trust boundary |
| F-14 | Low | Remediated | Stop-only host snapshots |
| F-15 | Low | Remediated | Workbench URL credential exposure |
| F-16 | Low | Remediated | Widget bridge pending calls |
| F-17 | Low | Remediated | Predicted-execution cancellation |

## Remediated findings

### F-01 — Invalid JSON-RPC shapes

The MCP HTTP adapter now validates the JSON-RPC envelope before authorization or dispatch. Null,
scalars, arrays, invalid method names, invalid identifiers, and invalid parameter shapes are rejected
with a bounded Invalid Request response instead of being treated as notifications or dereferenced.
Unsupported batch input is handled explicitly. Request, response, and streamed frame sizes are
validated with safe integer limits and cannot be bypassed with malformed or misleading
Content-Length values.

Regression coverage exercises malformed envelopes and the previous null/scalar/array cases.

### F-02 — Cross-request MCP cancellation

The HTTP adapter now exposes an explicit caller-owned protocol-state seam. Authenticated requests
that share that state share the active request registry, allowing notifications/cancelled to reach
the request id created by an earlier request. Each request still has its own transport signal, and
active entries are removed in settlement paths. The state boundary is deliberately explicit so
deployments can bind it to an authenticated MCP session rather than accidentally sharing requests
between users.

Regression coverage verifies cancellation across separate HTTP requests and cleanup after completion.

### F-03 — MCP authorization exceptions

Authorization callbacks are contained by the transport. An authorizer exception fails closed and
returns a generic bounded transport response without leaking callback error text or rejecting the
documented no-throw HTTP handler contract. Application logging remains the host's responsibility.

Regression coverage exercises throwing authorization callbacks.

### F-04 — Pi stale abort listeners

Pi turns now have per-turn ownership and cleanup. The external abort subscription captures the
turn identity, is removed on every settle/error/cancel path, and cannot cancel a later turn after
the original turn has ended. A reused signal therefore cannot target a newly active session turn.

Regression coverage aborts an old signal after starting a second turn and verifies that the second
turn continues.

### F-05 — Native stale abort listeners

The native backend now captures the controller and turn identity created for the current turn.
External listeners are removed when the turn settles, and a callback only aborts the controller
that it subscribed to while that turn remains current. This prevents old request signals from
following the mutable session controller into later work.

Regression coverage covers listener cleanup, stale signals, and replacement/cancel races.

### F-06 — Late native model output

Native model and tool boundaries now re-check cancellation and current-turn ownership after every
awaited boundary and before mutating history or emitting assistant/completed events. Late provider
results are discarded or converted to the normal stopped path. A generation/identity guard prevents
a replaced turn from completing another turn.

Regression coverage uses a provider that returns after cancellation and verifies that no late
assistant message or successful completion is committed.

### F-07 — Workflow retry listener lifetime

Retry delays now use a single settle path that clears the timer and removes the abort listener on
resolve, reject, and abort, including the registration race where a signal aborts immediately.
Repeated retries no longer accumulate listeners on a long-lived signal.

Regression coverage checks successful backoff cleanup as well as cancellation.

### F-08 — Workflow nesting depth

Nested WorkflowContext.run calls now carry the current depth and invoke the next step at depth plus
one. The configured maximum depth is enforced for recursive, branch, and nested workflows; the
global maximum-step limit remains an independent backstop.

Regression coverage verifies that recursive context.run reaches the depth limit rather than relying
on the step limit.

### F-09 — Malformed agent events

Agent event validation now checks the complete discriminated event union, required event-specific
fields, bounded identifiers and text, finite numeric values, array/object sizes, and payload depth.
The transport rejects malformed events before view-model projection, while the projection path also
guards against malformed data as defense in depth.

Regression coverage includes null and structurally invalid assistant/tool payloads and oversized or
deep payloads.

### F-10 — CRLF SSE framing

The agent SSE parser now accepts LF, CRLF, and CR framing, including delimiters split across read
chunks, and flushes a complete final event at EOF. It remains bounded by a maximum response/frame
size.

Regression coverage includes CRLF streams and split-boundary parsing.

### F-11 — Early SSE consumer exit

When an SSE consumer exits early, the response reader is cancelled before its lock is released.
The implementation preserves the original parse/transport error if reader cancellation itself
fails. This releases producer, socket, and buffer resources when a UI view no longer needs the
stream.

Regression coverage observes cancellation of the underlying response body after early iteration
exit.

### F-12 — Unbounded file session history

FileSessionStore now validates and enforces maximum entry size, maximum entry count, and maximum
total bytes. Reads are tail-oriented and bounded to the requested history window instead of loading
an unbounded JSONL file before slicing it. Replay/fork/checkpoint handling uses bounded immutable
records and does not allow caller mutation to alter stored history.

Regression coverage exercises byte/count retention, bounded history reads, malformed records, and
replay immutability.

### F-13 — Unbranded raw HTML

All framework Content adapters now require the framework-neutral TrustedHtml brand for their
intentional raw-HTML sink. SanitizedHtml is an alias for integrations whose sanitizer returns that
vocabulary, and trustHtml/sanitizedHtml make the decision explicit and audit-greppable. Ordinary
strings no longer type-check accidentally.

The brand is not a sanitizer. Untrusted user, API, or CMS HTML must be passed through a
well-reviewed allowlist sanitizer before the explicit constructor. Build-time markdown and
application-owned templates may use the constructor only after review. The adapters remain
deliberate raw-HTML sinks and are covered by adapter tests.

### F-14 — Stop-only host snapshots

CodingAgentHost now handles session.stopped as an explicit lifecycle transition, updating the
snapshot status and active-turn state from the authoritative stop event rather than spreading the
previous status. Sequence and timestamp monotonicity are preserved.

Regression coverage sends a stop-only backend event and checks the resulting snapshot.

### F-15 — Workbench URL token exposure

Workbench bootstrap credentials now travel in the URL fragment rather than the query string. The
browser consumes the fragment and immediately calls history.replaceState to remove it from the
address bar and history. The server continues to use loopback binding, bearer authorization,
constant-time token comparison, no-referrer, and restrictive response headers.

The fragment is still visible to local browser tooling before consumption, so packaged deployments
should prefer out-of-band bootstrap.

Regression coverage covers fragment bootstrap and cleanup behavior.

### F-16 — Unbounded MCP widget bridge calls

The widget bridge now bounds pending calls, expires calls with a timeout, rejects all pending calls
when the host disconnects, and removes each entry on every completion path. Generated identifiers
and retained pending state are bounded. Host messages continue to require the expected source.

Regression coverage covers timeout, disconnect, duplicate/late responses, and pending-count bounds.

### F-17 — Predicted-execution cancellation

executePredicted now exposes typed AbortSignal support. Prediction execution checks cancellation and
turn ownership, rolls back an active prediction when execution or reconciliation is cancelled or
fails, and cleans prediction registrations in all settle paths. Prototype-grafting paths remain
rejected by the patch validator.

Regression coverage covers cancellation during execution, rollback, reconciliation failure, and
concurrent registration/cleanup races.

## Earlier audit items that remain closed

The preceding 2026-08-20 audit recorded these items as remediated. They were rechecked as part of
the current tree and remain closed:

| Area | Current control |
| --- | --- |
| Image ETag/cache integrity | ETags hash emitted bytes; mutable-safe defaults and explicit immutable caching are enforced. |
| Local image TOCTOU | Verified descriptors are opened once with O_NOFOLLOW, checked with fstat, read bounded, and closed. |
| Memory cache growth | The reference cache has a finite LRU cap and incremental expiry sweeping. |
| Abandoned image work | Admission, fetch, local reads, codec work, and cancellation are abort-aware. |
| Forwarded Host poisoning | Forwarded host is fixed/validated opt-in rather than copied from raw inbound Host. |
| Dynamic head identity caching | Function-form metadata is not incorrectly identity-cached. |
| Upload NaN/infinite limits | Upload byte limits require valid safe finite integer values. |
| Image option validation | Width, quality, cache age, timeout, and related limits are validated at construction. |
| Local subprocess abort listener | Normal and exceptional settlement remove listeners and clear timers. |
| Cloudflare KV short TTL | Platform GC expiry is clamped without changing authoritative session expiry. |

## Positive security observations

- Core request-body readers bound both declared and streamed bodies and do not trust Content-Length.
- SSR loader data and head script content escape HTML parser breakouts. Executable inline scripts
  require a nonce and an allowlisted type.
- Head attributes reject event handlers, meta refresh, and active/local URL schemes.
- Node static serving denies dotfiles/traversal, checks realpath containment, opens verified paths
  with O_NOFOLLOW, streams with backpressure, and closes descriptors on abandonment.
- Proxy origins are fixed at construction. Redirects, hop-by-hop headers, forged forwarding
  metadata, and body/header stalls are handled defensively.
- Session ids use strong randomness. Signed cookies use a 256-bit secret floor, constant-time
  verification, mandatory HttpOnly, fail-closed reads, and regeneration against fixation.
- CSRF and WebSocket same-origin checks default closed for browser credential-bearing requests.
- MCP database execution defaults to schema-only, requires authorization for queries, uses read-only
  SQLite/plan checks, and bounds results and worker time.
- The local subprocess adapter limits inherited environment names, execution time, and captured
  output, while explicitly documenting that it is not a security boundary.
- WebMCP registration is explicit; capability execution reuses validation, policy, and evidence
  paths; prediction patches reject prototype-grafting paths.
- The Workbench server returns content-free projections and sets CSP, no-referrer, and nosniff.
- Widget receive-side checks require event.source === window.parent. The send-side postMessage("*")
  behavior is deliberate for sandboxed opaque-origin iframes and is documented as a host
  threat-model requirement.

## Static-scan inventory and intentional findings

Targeted Semgrep p/security-audit reports only the two expected raw-HTML sinks in:

- packages/web-preact/src/content.ts
- packages/web-react/src/content.ts

Those findings are intentional and are covered by the TrustedHtml brand and adapter tests. The
broader Semgrep auto scan is noisier; its six inventory items are:

- bench/http/serve-node.ts
- bench/http-realworld/serve-node.ts
- bench/proxy/serve-node.ts
- bench/proxy/serve-node-nifra.ts
- packages/web-preact/src/content.ts
- packages/web-react/src/content.ts

The benchmark entries are local benchmark servers, not shipped application handlers. The adapter
entries are the reviewed branded sinks above. Reviewed suppressions with rationale were added at
packages/mcp/src/react.ts and packages/web/src/internal/render-document.ts. No unreviewed actionable
Semgrep finding remains in the targeted security profile.

## Verification evidence

The final verification run produced the following:

- rtk tsc: passed.
- rtk npm run lint: passed; only broken symlink warnings under ignored data/browser artifacts.
- rtk npm run check:release: passed, including build, lint, typecheck, full tests, CLI isolation,
  coverage, corpus/docs, public-boundary/manifests, size/performance, publish/consumer checks,
  cold-start, Deno/Node/workerd, parity, and changeset validation.
- Focused regression suite: 267 passed, 0 failed across 15 files.
- Core performance gate: GET / at 334 ns/op median and GET /users/:id at 457 ns/op median, against
  a 10,000 ns/op budget.
- Mixed p99 benchmark: 1,268,551 requests, 0 errors; p50 0.23 ms, p99 0.55 ms, and p99.9
  1.06 ms.
- Memory soak: 6,358,649 requests over 60 seconds; steady-state RSS drift 0.1 MB.
- bun audit: clean across 729 packages.
- OSV root-lockfile scan: clean across 871 packages. The scan intentionally used the repository
  root lockfile only; ignored .claude/worktrees contain stale independent lockfiles and are not
  release dependencies.
- Gitleaks: no leaks across 951 commits and approximately 35.5 MB; remaining matches were in
  ignored/generated artifacts or dummy/test fixtures, with no production secret confirmed.
- Targeted Semgrep: only the two reviewed TrustedHtml sinks listed above.

## Deployment guardrails and residual considerations

These are not open findings in the current code; they are configuration and threat-model
requirements for operators:

1. Keep agent RPC loopback-only by default. If it must be exposed remotely, put it behind
   authenticated, encrypted transport with origin/tenant isolation and rate limits.
2. Bind MCP protocol state, active request ids, and cancellation to an authenticated session.
   Never share a state object across tenants.
3. Treat TrustedHtml/SanitizedHtml as a brand, not sanitization. Sanitize untrusted HTML before
   calling trustHtml and deploy CSP/Trusted Types where practical.
4. Treat subprocess execution as convenience execution, not sandboxing. Use an OS/container/VM
   boundary for hostile code, untrusted repositories, or tenant isolation.
5. Keep postMessage("*") only where opaque-origin sandboxed widgets require it, and validate
   source, message shape, method, origin-independent capability, and lifecycle at the host boundary.
6. For packaged Workbench deployments, use an out-of-band one-time bootstrap channel instead of
   putting even a short-lived credential in a launch URL.
7. Apply per-tenant quotas, authentication, rate limits, and external durable-store controls
   around the local reference session store and MCP tools.

## Public/private boundary

The public implementation exposes moat-neutral seams: typed cancellation and admission, bounded
transport/session interfaces, trusted HTML branding, WebMCP capability/prediction contracts, and
reference implementations. Private operated depth should remain in durable multi-tenant storage,
fleet-wide quotas, credentialed integrations, adaptive shedding, centralized audit/invalidation,
and deployment-specific isolation. This keeps the public framework useful without treating a local
reference adapter as a managed security service.

## Conclusion

F-01 through F-17 are remediated in the current working tree and backed by focused regression
coverage. The release-equivalent gate and independent security/performance checks are green. The
remaining risk is deployment-specific configuration and the intentionally explicit trust decisions
called out above, rather than an unresolved code finding from this audit.
