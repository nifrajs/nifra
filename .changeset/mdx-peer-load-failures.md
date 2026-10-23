---
"@nifrajs/web-solid": patch
"@nifrajs/web-svelte": patch
---

The Solid and Svelte MDX plugins load `@mdx-js/mdx` and `mdsvex` through the same optional-peer
loader as the Sass, PostCSS, StyleX and SVG plugins. A missing peer still fails with an install hint.
A peer that is installed but throws while loading now fails with that error as the cause, where it
was reported as not installed.
