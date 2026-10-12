---
"@nifrajs/cli": patch
---

`nifra migrate --from tailwind --to stylex --write` now places its StyleX import and `create()` block after the file's directives and imports even when comments sit around them. Before, a comment above `"use client"` put the block above the directive, so the file lost its client boundary, and a trailing `// comment` on the last import pushed the block to the end of the file, so the module threw a ReferenceError when it loaded.
