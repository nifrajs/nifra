---
"@nifrajs/web": patch
---

A self-hosted build serves a web-vanilla page from its prerendered file again. Every page of an adapter that swaps slots answers with `Vary: x-nifra-swap`, which the build took for a render specific to its request, so each one rendered on demand. A slot-swap request still renders its slot, and the file is served with the `Vary` header its render sent.
