---
"@nifrajs/web": minor
---

`clientEntry` is optional on a `hydrate: false` page.

A non-hydrated document references it nowhere - all three uses sit behind the `hydrate` guard - yet
every static page had to pass one anyway. `RenderPageInput` is now a union, so omitting it is allowed
exactly when `hydrate: false` is set and stays a compile error otherwise, rather than rendering
`<script src="">` and silently failing to hydrate.

Found by writing `examples/web-vanilla`, which is the first caller that genuinely has no client entry
to give.
