---
"@nifrajs/web": patch
---

A page, action or data request rendered in draft mode answers `cache-control: private, no-store` and advertises no ISR freshness, whatever `cache-control` its loader set, so neither `withISR` (with or without its own `draftSecret`) nor a URL-keyed CDN stores unpublished content for the next visitor.
