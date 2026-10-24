---
"@nifrajs/core": patch
---

A linked package's CommonJS file that has no counterpart in the app's copy keeps its exports under
single-copy. The registrar used to hand the file back to Bun as source, which loaded it as an ES
module, so both `require()` and `import` saw no exports. A bundle now loads such a file itself, and
the runtime loads it natively through a re-export of the file.
