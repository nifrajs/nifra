---
name: security-checkup
description: >
  Deterministic, no-AI security scan of the current repo: dependency advisories (osv-scanner),
  committed secrets (gitleaks), unsafe-pattern taint rules (semgrep), and the project verify gate.
  Normalizes every result into one Finding schema, writes .security/report.json + report.md, and
  exits with a CI-gateable contract. Makes no model calls and needs no API key.
allowed-tools: Bash
---

# security-checkup

A deterministic security scanner. It shells out to pinned tools, normalizes their output into one
`Finding` schema, writes two artifacts, and exits with a contract CI can gate on. **No model calls.**

It complements, and does not replace, nifra's own `securityBaseline()` route-assurance preset:
`security-checkup` scans the whole repo (deps, secrets, patterns); `securityBaseline()` proves
per-route invariants at `nifra check`. Ship both.

## Run it

```bash
bun .claude/skills/security-checkup/scripts/run.ts
```

| flag | behavior | exit |
| --- | --- | --- |
| (default) | all probes; artifacts written | `1` if any un-suppressed finding `>= high` |
| `--fast` | deps + secrets only (pre-commit) | `1` on any un-suppressed `>= high` |
| `--report-only` | scan + write artifacts | always `0` (dashboards, never blocks) |
| `--strict-tools` | pinned-tool version drift is fatal | `2` on drift |
| `--severity <sev>` | override gate threshold (critical..info) | `1` at/above threshold |
| `--out <dir>` | artifact dir (default `.security`) | - |

Exit codes: `0` clean / report-only, `1` findings at-or-above threshold, `2` operational failure
(unreadable repo, `--strict-tools` drift, malformed probe output). A crashed probe is a `2`, never a
silent `0`; a missing scanner prints `DEGRADED: <probe>` and still gates on the rest.

## Probes (pinned)

| probe | tool | pin | detects |
| --- | --- | --- | --- |
| deps | osv-scanner | 2.4.0 | vulnerable dependencies |
| secrets | gitleaks | 8.30.1 | committed secrets (value never written to the artifact) |
| patterns | semgrep | 1.99.0 | taint / unsafe-API rules in `rules/semgrep.yml` |
| verify | `bun run verify` | repo | the project gate, incl. nifra route assurance |
| outdated | `bun outdated` | repo | stale deps (advisory, `info`) |

Update pins in `scripts/probes.ts` (`TOOL_PINS`). Drift is reported as a `high` finding, or fatal
under `--strict-tools`.

## Artifacts

Written to `.security/` (git-ignore it or commit it, your call):

- `report.json` - the machine gate input (the `Report` schema in `scripts/schema.ts`).
- `report.md` - human summary: counts, findings by severity, suppressed section.

Both are pure functions of the collected findings; only the timestamp line varies on an unchanged
tree, so diffs stay small.

## Accepted risk (suppression)

`config/baseline.json` maps a finding `fingerprint` to `{ reason, expires? }`. A suppressed finding
is still written (with `.suppressed`) and does not gate - but an **expired** suppression is
re-promoted to `high` and gates again. Suppression matches by fingerprint, so a finding that moves in
the code lapses its suppression by design.

```json
{
  "abc123def4567890": { "reason": "test fixture key, not live", "expires": "2027-01-01" }
}
```

## When to use

- **Pre-commit hook:** `run.ts --fast` (deps + secrets, quick).
- **CI PR check:** `run.ts` (full, blocks on `>= high`).
- **Nightly dashboard:** `run.ts --report-only` (never blocks; publishes the artifact).

## Wiring (optional)

Pre-commit (`.git/hooks/pre-commit` or your hook manager):

```bash
bun .claude/skills/security-checkup/scripts/run.ts --fast || exit 1
```

CI step:

```bash
bun .claude/skills/security-checkup/scripts/run.ts
```
