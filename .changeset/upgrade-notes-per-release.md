---
"@nifrajs/cli": minor
"@nifrajs/core": minor
---

`nifra upgrade` carries a 5.1.0 recipe, so an upgrade across 5.1.0 prints what can change for an app: merged routes recompiled under the parent's response contract and effect ledger, cross-site form posts refused with `403`, and `clientIp.trustedHops` with no socket peer. `nifra upgrade --list` prints the notes of every release after the version the project declares, and `--json` carries `installed` and every version's `notes`.

`reflectHooks` (and so `nifra routes --hooks`, and the hook-scope diff `nifra upgrade` saves) lists the runtimes a route resolved at registration beside its hooks: `responseContract` named by its mode, `effectLedger` and `idempotency`, each with the site `route`. A merged route that gains a parent's contract on upgrade now shows up in `nifra routes --hooks --since`.

The release gate fails a minor or major release that has no upgrade recipe of its own.
