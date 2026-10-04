---
"@nifrajs/cli": patch
---

The verification work graph (`nifra_verify` and the work-graph report):

- `.svelte`, `.vue`, `.mdx` and `.css` files are app source. An edit to one after the last build makes the build stale, and each file is a node of the graph.
- A changed file under `routes/`, `frontend/`, `backend/` or `shared/` that the graph does not model, such as a deleted module, impacts every route and needs proof. Previously the plan was empty and the change was reported as done.
