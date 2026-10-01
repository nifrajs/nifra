---
"@nifrajs/web": patch
---

fix(web): a hydrating page with an empty `clientEntry` throws instead of rendering `<script type="module" src="">`.
An empty `src` resolves to the page's own URL, so the browser would load the document as a module.
Rendering a hydrating page with an empty or missing entry now throws a `TypeError` naming the fix,
from `renderPage` and from `createWebApp` pages alike. A `hydrate: false` page never references the
entry and still renders without one.
