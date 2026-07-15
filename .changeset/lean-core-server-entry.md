---
"@nifrajs/core": minor
"@nifrajs/auth": patch
"@nifrajs/better-auth": patch
"@nifrajs/client": patch
"@nifrajs/devtools": patch
"@nifrajs/deno": patch
"@nifrajs/events": patch
"@nifrajs/middleware": patch
"@nifrajs/node": patch
"@nifrajs/otel": patch
"@nifrajs/prompt": patch
"@nifrajs/schema": patch
"@nifrajs/web": patch
"@nifrajs/workers": patch
"create-nifra": patch
---

Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.
