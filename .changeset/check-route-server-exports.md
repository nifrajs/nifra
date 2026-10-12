---
"@nifrajs/cli": patch
---

`nifra check` reports a route, layout, error, not-found, status or loading `.tsx`/`.jsx` that exports `loader`, `action`, `middleware` or another server-only name as NF-C041, an error, matching the build and the server, which already refuse it. `nifra fix --code NF-C041` moves the export and the code only it uses into the route's `.backend.ts`, merging with the one that exists. `nifra fix --code NF-C038` now runs the layout migration it names; its recipe was missing, so the fix did nothing.
