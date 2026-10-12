---
"@nifrajs/web": patch
---

A root catch-all page (`routes/[...slug].tsx`, or `routes/[[lang]]/[...rest].tsx`) no longer makes `createWebApp` throw `conflicting parameter names for "/*"`. The framework's own fallback for unmatched paths is left out when a page already answers every path, the root included.
