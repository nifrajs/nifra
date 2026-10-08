---
"@nifrajs/agent": patch
---

`assembleContext` counts each candidate set in the source order it returns, so a custom `tokenCounter` that scores the same items differently by order can no longer return text over the budget. The returned text is counted once more, and a count over the budget throws `ContextBudgetError`.
