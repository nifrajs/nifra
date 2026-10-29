---
"@nifrajs/core": patch
---

Stop marking GET and HEAD requests as runtime-framed on Bun's native route table. Those slots take no body, so the symbol write on every request was dead work; body methods are still marked.
