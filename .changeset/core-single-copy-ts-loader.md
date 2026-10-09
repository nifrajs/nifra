---
"@nifrajs/core": patch
---

The single-copy runtime plugin hands back a linked copy's file that has no counterpart in the app's copy with the loader its extension names. It always used the `js` loader, so a TypeScript or JSX source file (`.ts`, `.mts`, `.cts`, `.tsx`, `.jsx`) in a linked package failed to parse instead of loading from the linked copy.
