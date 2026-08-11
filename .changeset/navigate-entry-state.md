---
"@nifrajs/web": minor
---

`navigate()` accepts a `state` option: opaque, structured-cloneable per-entry state stored on the
history entry it creates, in both the string and object call forms. It is written under
`history.state.nifraState` so it can never collide with the router's own bookkeeping keys
(`nifraIndex`/`nifraScroll`), read back as `history.state.nifraState`, and restored by the browser on
back/forward at no cost. History-delta navigations (`navigate(-1)`) ignore it.
