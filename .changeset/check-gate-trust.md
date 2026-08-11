---
"@nifrajs/cli": minor
---

`nifra check` verdicts are now install- and cwd-invariant, fully visible in the text report, and configurable per rule:

- **Report parity.** Every diagnostic that affects the exit code now appears in the human text report, not only in `--json` - registry rules and application rule packs render under their code titles, and the trailer states the exact error/advisory counts behind the verdict.
- **Typecheck can no longer skip silently.** A project with a `tsconfig.json` but no installed TypeScript now fails the check with an actionable diagnostic (`bun add -d typescript`) instead of a dim skip line, and the skip note names the reason.
- **Project-resolved compiler.** `tsc` and the TypeScript API used by compiler-backed lints resolve upward from the project root (monorepo hoisting included), so verdicts no longer depend on the working directory or on how the CLI was installed. Security lints that cannot run without TypeScript emit an explicit "did NOT run" advisory instead of passing silently.
- **`nifra.check.json` rule overrides.** A new `rules` map accepts per-rule `severity` (`error`/`warn`/`info`/`off`) and `ignore` globs, keyed by NF- code or legacy rule name; applied overrides are echoed in the report and the JSON result for auditability, and invalid entries warn instead of silently applying.
- **NF-S002 severity by file role.** Non-constant-time secret comparisons in server-role files (`*.server.ts`, `server/`, `backend.ts`) stay errors; the same pattern in client-leaning files (`.tsx`/`.jsx`, `routes/`) reports as a warning. The `@nifra-gate-reviewed` marker now applies from anywhere inside the preceding comment block.
