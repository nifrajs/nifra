---
"@nifrajs/web": patch
---

The private-env check reads every Svelte and Vue script block however its closing tag is spaced (`</script >`), CSP hashing finds the hydration head's inline scripts the same way, and development parity ends an SFC comment at `--!>` as a browser does.
