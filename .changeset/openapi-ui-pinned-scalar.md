---
"@nifrajs/middleware": patch
---

`openapi({ ui: true })` now loads an exact Scalar build (`@scalar/api-reference` 1.72.1's `dist/browser/standalone.js` on jsDelivr) with a Subresource Integrity hash and `crossorigin="anonymous"`. Before, the page loaded the unversioned package URL with no integrity check, so whatever was published as `latest` ran on the API's own origin. A new `ui.integrity` option sets the hash for a self-hosted copy given as `ui.cdn` (which gets no hash unless you pass one), or `false` to send none.
