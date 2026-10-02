---
"@nifrajs/web": patch
---

A generated Bun, Node or Deno server serves `public/` files and the client bundle with their content type, `x-content-type-options: nosniff` and a cache policy: immutable for the hashed `/assets/`, one day for the rest. A `robots.txt` or an `.svg` no longer arrives as a download, and the bundle no longer downloads again on every visit.
