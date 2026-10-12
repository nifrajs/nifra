---
"@nifrajs/cli": patch
---

The MCP tools, `nifra fix` and `nifra review` now refuse a project path that is a dangling symlink pointing outside the project, such as an `api-snapshot.json` linked to a file that does not exist yet elsewhere. Before, the containment check walked up to the link's existing parent, found it inside the project and allowed the path, so a write through the link created the file outside the project. A dangling link whose target is inside the project still works and resolves to that target.
