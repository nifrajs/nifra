---
"@nifrajs/core": patch
"@nifrajs/cli": patch
---

Reject adjacent mixed-route parameter values that the router would split differently, including percent-encoded values that would become malformed captures.

Make internal-link diagnostics account for stripped backend mounts, ignore commented-out and script-string anchors in Vue/Svelte components, and honor template-comment suppressions. Detect navigation imports from browser-safe router and client subpaths when checking route-table coverage.
