---
"@nifrajs/core": minor
---

Route assurance gains a tiered `securityBaseline()` policy preset and two route selectors, `hasBody` and `bodyLimit`.

`securityBaseline({ level })` returns an `AssurancePolicy` built entirely from the public assurance engine, so it inherits fail-closed evaluation, evidence provenance, and selector validation. Its rules are ordered most-specific-first because evaluation is first-match-wins: each route is owned by one rule that carries the full requirement bundle for its class. Three levels, each a superset of the last:

- `"essential"` - never false-positives on a reasonable app: a body read must be bounded, an `unlimited` body may never claim `nifra.body-bounded`, an agent tool ingress must be bounded, and an authenticated state change must prove CSRF. Every requirement is either core-published from the route schema or demanded only where the route already opted into the risk.
- `"standard"` (default) - essential plus: a route the app classified `pii` or higher must be authenticated, read or write.
- `"strict"` - standard plus the opinionated requirements that need installed middleware: every route carries a response contract, every read carries security headers, every mutation is rate limited.

`unmatched` defaults to `"ignore"` for additive adoption; set `"error"` to close it into an allow-list. `requireRuntimeProvenance` defaults to `true` - an author label is not proof.

The new selectors let any policy match on body shape: `hasBody` matches routes that declare (or omit) a body schema, and `bodyLimit` distinguishes `"bounded"`, `"unlimited"`, and `"unset"`. Both are validated at `defineAssurancePolicy` time and refuse unknown values, so a typo cannot open a policy hole.

Drop the preset into a `nifra.assurance.ts` `policy`, or spread it and append project-specific rules ahead of the baseline so they own their routes first.
