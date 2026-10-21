---
"@nifrajs/web": patch
"@nifrajs/web-vanilla": patch
---

A swap answers only with a slot that survives in the final composed page, an append disposes the islands it removes, and swap requests bypass the browser cache. Links and GET forms swap; POST forms submit natively, so the browser applies the response's security policy and scripts. A swapped slot runs under the current page's Content-Security-Policy, which stays on the document response alone. Native action pages include their island entries.
