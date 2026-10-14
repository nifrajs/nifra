---
"@nifrajs/web": patch
---

`servePublicDir` reads a body of up to 256 KiB whole through its pinned descriptor and closes it before the response leaves. A larger body still streams. On Bun, a 200 KB public file is served in 0.17 ms where a `node:fs` stream took 0.28 ms; a 10 KB file takes 0.12-0.14 ms instead of 0.16 ms. The self-hosted Bun, Node and Deno entries serve static files through this handler.
