---
name: nifra-verify
description: Use before declaring Nifra work complete, when a Nifra CI gate fails, or when wiring Nifra checks into CI - `nifra check` drift gate, `nifra assure` route security evidence, `nifra capabilities check` effect provenance, `nifra manifest diff` deploy promotion, `nifra doctor`, the verification ladder, and contract-derived testing with @nifrajs/testing. Load after the `nifra` skill.
metadata:
  docs: https://nifra.dev/docs/verification
---

# Nifra: the gates

Nifra turns "did you do this right" into build failures. The gates exist so an agent can check its own
work instead of asserting success. Run them; do not route around them.

## The done-gate

```sh
nifra check --json      # or the nifra_check MCP tool
```

`nifra check` typechecks the frontend/backend contract and flags drift: a hand-rolled `fetch()` at
this app's own API, a server-only import inside `routes/`, a client call whose route changed shape.
Findings carry the fix.

**A failing check means the work is not done.** Do not suppress a finding, widen a type, or add a
cast to make it pass. If a finding is genuinely wrong for this codebase, say so explicitly to the
person you are working for rather than quietly silencing it.

`nifra doctor` is the other half: environment and build-state problems (stale `dist/`, duplicate
framework install, misconfigured adapter) that make correct code behave wrongly.

## Security evidence per route

```sh
$ nifra assure
✖ POST /notes (authenticated-write) is missing nifra.authenticated
```

A policy file classifies every route by reflection, then `assure` fails CI naming exactly which
evidence is absent: authentication on a write, a rate limit, CSRF, a body cap. When you add a route,
you add its evidence in the same change. When `assure` names a gap, add the real control - never
reclassify the route to make the requirement disappear.

## Effect provenance

Routes declare the effects they perform:

```ts
app.post("/notes", { capabilities: ["db.write"] }, handler)
```

`nifra capabilities check` compares what a route *declares* against what its module graph can
actually *reach*, pinned in a lockfile. A `GET` that can reach a domain write is an error.

The common cause of a surprise failure is a barrel file: importing one helper from `./lib` drags the
whole module graph's reach into the route. The fix is to narrow the import, not to widen the
declaration.

## Deploy promotion

`nifra manifest diff` emits one hash-verified artifact - contracts, assurance, effects, response
sensitivity - and fails closed on a breaking contract change, lost assurance, or a newly exposed
sensitive field. Run it between environments, not just at merge.

## Testing

`@nifrajs/testing` derives tests from the contract rather than from your assumptions:
adversarial/hostile input generation, response conformance, replay, shrinking, and a runtime-matrix
check that the same app behaves identically on Bun, Node, Deno, and Workers.

Prefer a contract-derived test to a hand-written one that re-asserts the schema. Hand-write the tests
covering business rules the contract cannot express.

## The verification ladder

Five cumulative levels, from "has a typed contract" up to "has contract-derived invariant tests".
`nifra levels` (or `nifra_levels`) reports where the project actually stands.

Use it honestly: report the level the project holds, not the one it aspires to. Raising a level means
adding the evidence, not editing the claim.

## Suggested CI order

```sh
nifra check          # contract drift
nifra assure         # route security evidence
nifra capabilities check
bun test             # incl. contract-derived tests
nifra manifest diff  # promotion gate, between environments
```

Fail the build on each. A gate that only warns is a gate that gets ignored.
