---
"@nifrajs/cli": patch
---

Every catalog command answers `--help` with its usage, and a missing or unknown subcommand prints the
usage after the error, so `nifra contracts --help` and a bare `nifra contracts` both show
`snapshot | check`. The `nifra check` report prints a fix that several findings share once, after
them, instead of under each one.
