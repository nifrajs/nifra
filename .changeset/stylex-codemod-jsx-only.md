---
"@nifrajs/cli": patch
---

`nifra migrate --from tailwind --to stylex` now rewrites only real JSX `className` attributes. A `className=` inside a template literal, string, comment, regex or JSX text is left as written, and a `.ts` module (which cannot hold JSX) is not rewritten.
