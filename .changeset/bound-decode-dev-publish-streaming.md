---
"@nifrajs/image": patch
"@nifrajs/i18n": patch
"@nifrajs/web": patch
---

Bound nested percent-decoding when translated pathnames are looked up, and refuse segments nested deeper than three encodings. Publish each development image asset once per build instead of re-verifying earlier ones on every import. Mark ordinary Vercel Node functions as response-streaming.
