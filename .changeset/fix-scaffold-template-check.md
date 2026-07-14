---
"create-nifra": patch
---

Fix fresh scaffolds failing their own `nifra check`, plus two scaffolding tooling defects:

- All counter demo templates (site ×5 frameworks, isr): demo loaders now narrow on `res.ok`
  before reading `res.data` — un-narrowed `data` is `{}` under the typed client, so the old
  `res.data?.count` was a compile error on a fresh scaffold.
- Demo backends now lock output shapes with `response` schemas (`t.object(...)`), per the
  AGENTS.md doctrine the templates themselves ship.
- `template-isr` now includes `@nifrajs/cli` in devDependencies so a scaffolded app can run
  its own `nifra check` done-gate.
- `--link` computes `file:` paths from realpaths — a symlinked segment (macOS tmpdir
  `/var/folders` → `/private/var/folders`) previously skewed the relative path and broke
  every linked dependency.
- New regression suite `test/scaffold-check.test.ts`: static tier always asserts the
  template sources carry both contract fixes; live tier (`SMOKE_SCAFFOLD=1`) scaffolds for
  real, installs published packages, and runs `nifra check`.
