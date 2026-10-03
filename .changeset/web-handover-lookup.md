---
"@nifrajs/web": patch
---

The generated client entry reads page state only from the server's own `<script type="application/json">` handover (the last one in the document), and sets only the page-state globals it names. Page content that carries an element with the same `id` - sanitized user HTML, say - no longer reaches `window`.
