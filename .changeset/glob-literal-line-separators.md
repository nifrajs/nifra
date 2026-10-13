---
"@nifrajs/web": patch
---

The Bun build's `import.meta.glob` expansion writes each key, import path and `import` export name as a string literal with U+2028 and U+2029 escaped, so the generated code stays on one line for every JavaScript parser.
