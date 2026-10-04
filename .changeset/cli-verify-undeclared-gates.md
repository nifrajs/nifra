---
"@nifrajs/cli": patch
---

`nifra verify` and `nifra_verify` report a gate whose `package.json` script the project does not declare as `undeclared` instead of running it and failing. A project that declares `lint` and `test` gets those two gates run and the rest listed as not declared; the run passes when every gate that ran passed, and fails when none ran.
