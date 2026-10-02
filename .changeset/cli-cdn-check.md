---
"@nifrajs/cli": minor
---

`nifra cdn-check <url>` checks a deployed page behind a CDN. It requests the page twice and once as a soft navigation, names the CDN (Cloudflare, Vercel or Fastly) from its status header, and reports whether the second request was served from cache. It fails, exiting 1, when `x-nifra-isr-*` headers reach the visitor or when a soft navigation is answered with the cached document, which is what a Cloudflare zone does without a Cache Rule bypassing requests that carry `x-nifra-data`. It also warns when CDN-only headers are visible or when browsers may keep the HTML. CLI only.
