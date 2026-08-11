---
"@nifrajs/node": minor
---

The static file server denies dotfiles by default. A request whose path contains a dot-leading
segment (`/.env`, `/.git/config`, `/.hidden/app.js`) - including `%2E`-encoded spellings - answers
`404` with the same body as a missing file, so probing cannot distinguish "hidden" from "absent".
Dotfiles land in build output by accident (`.env` next to the bundle, a copied `.git` tree), so
serving them is opt-in: set the new `dotfiles: "allow"` option when the directory deliberately
contains them (e.g. `/.well-known`). Filenames that merely contain dots (`logo..png`) are
unaffected; the check rides the existing traversal pass, adding no filesystem access and no
per-request cost on clean paths.
