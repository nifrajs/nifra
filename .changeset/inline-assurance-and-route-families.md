---
"@nifrajs/core": minor
---

Route assurance reaches two places it couldn't before: in-handler guards and dynamic route families.

- **Inline `schema.assurance`.** A route (or contract op) can declare the enforcement evidence it carries adjacent to the handler - `{ assurance: [NIFRA_ASSURANCE.AUTHENTICATED] }` - and each id reflects as route-scoped `declared` evidence. A route whose guard runs inside the handler body (invisible to reflection) can now satisfy a policy `require:` clause without being rewritten into a `withRouteAssurance`-marked middleware. Invalid evidence ids fail closed at registration.
- **`flagClassifiedWithoutEvidence` policy option.** Opt-in. When set, a route matched by a pure-classification rule (no `require`, no `forbid`) that carries no evidence is reported as `classified-no-evidence` - making the "a classification-only policy silently degrades proof to a label" gap visible instead of green. Off by default (a genuinely public route legitimately carries no evidence).
- **`schema.family` dynamic route families.** A runtime-resolved template (`/api/:slug/:resource` over tenant-defined tables, a catch-all dispatcher) can be marked `{ family: true }`. It surfaces as `family` in reflection, so the assurance gate and tooling read the one templated route as a deliberate family whose evidence covers every runtime-resolved resource, rather than a single forgotten route. Purely declarative - it does not change dispatch.
