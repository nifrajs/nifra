---
"@nifrajs/web": patch
---

The client router keeps a page whose path starts `//` or `/\` on its own origin. A catch-all route serves `https://shop.example//evil.example/x`. On that page, revalidating, navigating, submitting, and the full-page fallback used to pass the path to `fetch`, `history` or `location` as written. A browser reads such a path as a protocol-relative URL to `evil.example`, so it fetched that host's JSON and committed it as route data. These calls now resolve against the page's own origin.
