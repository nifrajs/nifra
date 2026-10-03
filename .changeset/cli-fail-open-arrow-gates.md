---
"@nifrajs/cli": patch
---

NF-S001 reads a gate written as an arrow or function expression by the name it is bound to, such as `const requireAuth = async () => …` or `{ canEdit: () => … }`, so a fail-open catch in one is reported like one in a function declaration.
