---
"@nifrajs/core": patch
"@nifrajs/cli": patch
---

Refuse a cross-site HTML form post to an unsafe route that has no `schema.body`. The `403 forbidden_origin` check that body-schema routes already apply now runs ahead of every lane for a `POST`, `PUT`, `PATCH` or `DELETE` route without a body schema too, including Bun's native route table; `formOrigins` admits the same origins as before.

`nifra mcp` no longer adopts a workspace member that a `workspaces` pattern reaches through `..`, an absolute path, or a symlink out of the workspace root.
