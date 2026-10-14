---
"@nifrajs/web": patch
---

The server entry `buildTarget` generates for `bun`, `node` and `deno` serves static files the way `nifra dev` does. Bun and Node now hand a manifest-approved path to `servePublicDir`, and Deno runs the same checks on its own file API: the real path must sit inside the deploy directory, so a symbolic link planted in the deployed tree no longer reaches a file outside it; a HEAD request is answered from the file's size instead of reading it whole (the Node entry read the entire file); and a single byte range gets a `206` (an unsatisfiable one a `416`), with `accept-ranges` advertised.
