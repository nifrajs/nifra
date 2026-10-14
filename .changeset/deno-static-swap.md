---
"@nifrajs/web": patch
---

The self-hosted Deno entry's static handler applies `servePublicDir`'s hidden-file rule to the real path, so `/assets/<name>` linking to a `.env` inside the deploy directory is 404 rather than served. It also checks that the file it opened is still the one at the checked real path. `Deno.open` follows links, so a directory swapped for a link after the containment check used to redirect the open outside the deploy directory.
