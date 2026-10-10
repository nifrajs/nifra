---
"@nifrajs/middleware": patch
---

Respect response revalidation directives and freshness when caching responses. Bypass no-cache and stale responses, cap the application TTL by max-age or s-maxage and Age, and reject old stored entries that require validation.
