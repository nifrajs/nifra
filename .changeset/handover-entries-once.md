---
"@nifrajs/web": patch
---

A hydrating page's handover entries (the route id, the prerendered paths, the copy chunks and the locales) are serialized when its cached document pieces are built, instead of on every render. A page that does not hydrate serializes none. The document bytes are unchanged.
