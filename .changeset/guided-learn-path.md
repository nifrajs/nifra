---
"@nifrajs/cli": minor
---

A guided, ordered path to build a nifra app end to end.

`nifra_learn` (MCP) and `nifra learn` (CLI) walk the same sequence - create the app, add a page route, load data, add a typed API, call it through the typed client, protect a route, do background work, deploy. Each step names the tool that emits the correct artifact (`nifra_scaffold`, `nifra_example`, `nifra_run`) and how to verify it, so the path composes the existing tools instead of pasting code that can drift from the installed version. Random-access search stays `nifra_docs`/`nifra_example`; this is the sequence for building something new.
