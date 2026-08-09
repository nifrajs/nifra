---
"@nifrajs/cli": minor
---

Every run says which bundler it is on. `nifra dev` and `nifra build` print a `bundler:` line under their banner - the pipeline, and how it was arrived at: the Bun default with the flag that switches away from it, a `--vite` / `--bun` the user asked for, or an automatic Vite selection with the config reason that forced it. An auto-selected Vite build no longer looks like the default.

`nifra check` and `nifra doctor` answer the same question without starting a server, and the `nifra_check`, `nifra_doctor` and `nifra_context` MCP tools return it in their results. They read the config as text, so the answer is available on a repo before its dependencies are installed.

They also report the hazards that exist only because there are two pipelines:

- a plugin in the slot the other bundler reads - accepted, never called, and the build still succeeds
- a dev toolchain imported by the file `nifra build` bundles into the production server entry, which builds cleanly and then fails at startup on a bundler dependency
- `conditions` under `nifra dev` on Bun, whose client bundler takes no resolve conditions

Slot mistakes and a toolchain in the server entry fail the check; the resolve-condition notice is advisory.

The dev-and-HMR guide gains a "Which pipeline runs, when" table covering every config and flag combination, and the terminal output that answers it for a given app.
