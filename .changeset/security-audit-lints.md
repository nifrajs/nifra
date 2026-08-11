---
"@nifrajs/cli": minor
---

Four new built-in security lints in `nifra check`: `NF-S004` warns when a `cors` origin predicate never reads the origin (it allows every origin), `NF-S005` warns on `redirect(..., { external: true })` call sites so open-redirect surfaces stay auditable, `NF-S006` warns when a security escape hatch (`allowLengthless`, `allowGlobalKey`, `allowInProduction`) is enabled and names the assurance claim it weakens, and `NF-S007` (info) nudges Secure cookies toward `__Host-`/`__Secure-` prefixes. All four honor the `@nifra-gate-reviewed` marker and share the existing one-parse-per-file pipeline.
