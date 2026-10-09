---
"@nifrajs/web": patch
---

With `apiStrip: true`, `/llms.txt` and `/llms-full.txt` list each backend route at the URL a visitor calls (`/api/v1/forms`), not at the backend's own unprefixed path (`/v1/forms`), which the page router answers instead.
