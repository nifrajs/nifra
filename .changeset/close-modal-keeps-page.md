---
"@nifrajs/web": patch
---

Closing a modal route with Back shows the page underneath as it was instead of fetching it again. The fetch rebuilt the page's dynamic boundaries: each showed its fallback and then refilled, under a page that never left the screen. The router now restores the page it kept, unless that page was loaded for a previous visitor or marked stale.
