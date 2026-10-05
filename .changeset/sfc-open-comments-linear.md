---
"@nifrajs/web": patch
---

Checking a Svelte or Vue file for private environment reads, and the development parity check, take time in proportion to the file's length when an HTML comment or a `{{` interpolation is left open.
