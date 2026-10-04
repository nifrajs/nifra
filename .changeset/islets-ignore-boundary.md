---
"@nifrajs/islets": minor
---

`data-island-ignore` marks a subtree the island runtime leaves alone: no `data-bind-*` attribute inside it binds, and no `data-island` inside it mounts. Render user-supplied HTML there, so markup that kept its `data-*` attributes through a sanitizer cannot reach the island's handlers or signals. The full-feature island bundle stays under 2 KB gzipped.
