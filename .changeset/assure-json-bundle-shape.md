---
"@nifrajs/cli": minor
---

`nifra assure --json` again emits the route-assurance report `{ ok, routes, findings }`. A prior release
had silently repurposed `--json` to print the structured `{ version, gates, verdict }` assurance bundle,
so a consumer parsing the report shape saw its fields vanish with no version signal. The bundle is now
opt-in behind an explicit `nifra assure --bundle` (always JSON); the bundle-only flags `--strict`,
`--hydration`, `--interact`, and `--out` continue to imply it, and `--bundle --json` still yields the
bundle. Plain `nifra assure` prints the human table as before. If you adopted `assure --json` for the
bundle since it changed, switch to `assure --bundle`.
