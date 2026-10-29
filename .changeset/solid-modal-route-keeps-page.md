---
"@nifrajs/web-solid": patch
---

Opening a modal route on a Solid page no longer rebuilds the page. A layout was handed the `boundaries` value rather than a getter over it, so an intercept boundary taking its target re-ran the whole chain: a typed input lost its text and every component remounted. The page now stays mounted underneath, as the other adapters keep it.
