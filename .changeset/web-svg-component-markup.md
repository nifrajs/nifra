---
"@nifrajs/web": minor
"@nifrajs/web-svelte": patch
"@nifrajs/web-vue": patch
---

An `*.svg?component` import compiles its file as markup only, for every framework:

- JSX (React, Preact, Solid) spells braces, `>` and `=` in text and CDATA as character references. An exported stylesheet (`.st0{fill:#FFF}`, `a > b`) now compiles, and text such as `{...}` in a `<title>` renders as written.
- Svelte spells braces in text and attribute values as character references, keeps a nested `<style>` or `<script>` as raw text, and refuses a directive attribute (`use:`, `on:`, `bind:`...) or a `svelte:` element.
- Vue marks the root `v-pre`, so `{{ }}`, `:bound` and `v-` attributes are not compiled. A `<template>` tag is refused.
- The file must be one well-formed `<svg>` element, with every attribute value quoted and nothing after the root. Anything else fails the build with a message naming the problem. The check is exported as `svgTemplateMarkup()`.
