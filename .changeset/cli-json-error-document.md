---
"@nifrajs/cli": patch
---

A command run with `--json` that stops on an error (`nifra routes --json` outside a project, an unknown option, an exception the command throws) now prints `{ "ok": false, "error": "<message>" }` on stdout, beside the message on stderr and the same nonzero exit code. Before, stdout stayed empty, so a script or agent parsing it got a JSON parse error instead of the reason.
