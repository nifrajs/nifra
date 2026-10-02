---
"create-nifra": patch
---

The Vue site starter keeps its global stylesheet in an SFC `<style>` block, and the Preact starter renders its stylesheet unescaped, so both hydrate with no mismatch and the server-rendered page has its fonts before the client loads.
