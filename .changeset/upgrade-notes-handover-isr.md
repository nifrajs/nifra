---
"@nifrajs/cli": patch
---

`nifra upgrade` from 3.x names two 4.0 changes that show up in tests and tooling rather than in pages: page data arrives in one `<script type="application/json" id="__nifra-handover">` (read it through `HANDOVER_ID`) instead of a script assigning `window.__NIFRA_DATA__`, and `x-nifra-isr-revalidate` / `x-nifra-isr-tags` are set only under a cache wrapper such as `withISR`. The 5.0 migration guide lists both, and covers an app that strips `/api` in its own `Proxy` or `fetch` wrapper: replace it with `apiStrip`, and serve any other prefix it handled through `mounts`.
