---
"@nifrajs/web-vanilla": patch
---

An interpolated `data:` URL that begins a `<script>`'s `src` or `href` is written as `about:invalid`, as a `javascript:` URL already was. `data:` URLs on images, links, frames, objects and stylesheets are unchanged.
