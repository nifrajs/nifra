# Agent verification

The CLI exposes stable diagnostics for automation. Built-in codes use the `NF-` prefix and are append-only. Each structured diagnostic has a severity, a short message, optional source location and evidence, and optional fix and verify instructions.

Use `nifra check --json` for the normalized check report. Use `nifra fix --code <code>` to apply a registered recipe and run the check again. Use `nifra assure --json --strict` for one bundle with explicit gate status and a `green` or `red` verdict. A bundle includes check, doctor, render, hydration, contract, size, and idempotency gate results; prerequisites are represented as `skip` with a reason.

## Contract locks

`nifra contracts snapshot` writes `contracts.lock.json` from reflected route schemas. `nifra check` reports `NF-K001` when a lock exists and a request or response digest changes. A project without a lock receives an informational structured diagnostic so adoption is opt-in.

## Rule packs

An assurance config may provide application-supplied rule packs:

```ts
import type { CheckRule } from "@nifrajs/cli/rules"

export default defineAssuranceConfig({
  source: backend,
  policy,
  rulePacks: [{ name: "application", rules: [myRule satisfies CheckRule] }],
})
```

Pack codes must not start with `NF-`. Pack rules are pure scans and run after built-in rules. Fix recipes are registerable through `@nifrajs/cli/fix-recipes`; built-in mechanical recipes cover generated manifests, contract locks, workspace dist, and timing-safe secret comparisons.

## Replay and hydration

Replay metadata contains only a version, gate, case id, seed, input digest and structure-only metadata. `nifra replay <file>` validates and dispatches the unified envelope while accepting the existing adversarial and failure-lab metadata shapes. `nifra_hydrate` and `nifra assure --hydration` build the client, render SSR, and execute a DOM hydration proof with a seeded clock, random stream, and timer surface when `happy-dom` is installed; otherwise they report an explicit skip. Failures carry token-only replay files and `NF-H###` diagnostics.

## Security rules

The built-in AST checks emit `NF-S001` for narrow fail-open gate catches, `NF-S002` for direct secret comparisons, `NF-S003` for PII-shaped values passed to log calls, `NF-S004` for CORS origin predicates that never read the origin, `NF-S005` for `redirect(..., { external: true })` call sites, `NF-S006` for security escape hatches (`allowLengthless`, `allowGlobalKey`, `allowInProduction`) with the assurance claim each one weakens, and `NF-S007` (info) for Secure cookies set without a `__Host-`/`__Secure-` prefix. Add `// @nifra-gate-reviewed` on the flagged line or the line above only after review; the resulting informational diagnostic keeps the override visible in evidence.
