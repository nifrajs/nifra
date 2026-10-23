---
"@nifrajs/web-vanilla": minor
---

`html` writes each interpolated value for the place it lands. An unquoted attribute value is quoted, so a space in it cannot start another attribute, and a `javascript:` or `vbscript:` URL that begins `href`, `src`, `action` or another URL attribute is written as `about:invalid`. A string or nested template now throws as a tag name, inside `<script>` or `<style>`, or in an `on*` handler or `srcdoc` value, where no escaping makes it safe; numbers, booleans and `raw()` still fill those places. An attribute name takes a plain name with no value, such as `checked`, or a suffix after `data-` or `aria-`. A nested template inside an attribute value is escaped as text. Rendering is no slower: each call site's positions are read once and cached.
